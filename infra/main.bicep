// Azure Container Apps hosting for one tool. Deploy into an existing resource group:
//   az deployment group create -g <rg> -f infra/main.bicep -p deployApp=false      (infrastructure only)
//   az deployment group create -g <rg> -f infra/main.bicep -p image=<acr>.azurecr.io/<repo>:<tag>
// The GitHub Actions workflow does both on every push to main.

targetScope = 'resourceGroup'

@description('Short lowercase name used to derive resource names, e.g. nstcarbooking')
@minLength(3)
@maxLength(16)
param appName string = 'nstcarbooking'

param location string = resourceGroup().location

@allowed(['staging', 'production'])
@description('Staging may enable test logins. Production never does.')
param appEnv string = 'staging'

@allowed(['local', 'gateway'])
@description('local = email + password inside the app. gateway = Entra ID via Container Apps authentication (Easy Auth).')
param authMode string = 'local'

@description('Seed test logins and sample data (password for all: neumansteel123). Ignored — forced off — in production.')
param seedTestData bool = true

@description('Full image reference to run, e.g. myacr.azurecr.io/nst-car-booking:abc123. Required when deployApp = true.')
param image string = ''

@description('false = create the registry, storage and environment only (the first pipeline step), true = also create the app.')
param deployApp bool = true

@description('Gateway mode: comma-separated emails that are always admins.')
param adminEmails string = ''

@description('Public IPv4 ranges allowed to reach the app, e.g. ["203.0.113.0/24"]. Empty = open to the internet.')
param allowedIpRanges array = []

@secure()
@description('API key for the Data Export API (Fabric). Empty disables the export endpoints.')
param dataApiKey string = ''

@description('Version string reported by /health.')
param appVersion string = 'dev'

var suffix = uniqueString(resourceGroup().id, appName)
var acrName = 'acr${appName}${take(suffix, 6)}'
var storageName = take('st${appName}${suffix}', 24)
var shareName = 'app-data'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}'
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${appName}'
  location: location
}

// The app's identity pulls images from the registry (AcrPull).
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acr
  name: guid(acr.id, identity.id, 'acrpull')
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// Azure Files share that holds the SQLite database, so data survives restarts and new revisions.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    // Share snapshots / soft delete give a recovery path for the database file.
    shareDeleteRetentionPolicy: { enabled: true, days: 14 }
  }
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: { shareQuota: 5, enabledProtocols: 'SMB' }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${appName}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: 'appdata'
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      accessMode: 'ReadWrite'
    }
  }
}

// Export is only switched on when a key is supplied.
var dataKeySecrets = empty(dataApiKey) ? [] : [{ name: 'data-api-key', value: dataApiKey }]
var dataKeyEnv = empty(dataApiKey) ? [] : [{ name: 'DATA_API_KEY', secretRef: 'data-api-key' }]
var effectiveSeed = appEnv == 'production' ? false : seedTestData

resource app 'Microsoft.App/containerApps@2024-03-01' = if (deployApp) {
  name: 'ca-${appName}'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identity.id}': {} }
  }
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: acr.properties.loginServer, identity: identity.id }]
      secrets: dataKeySecrets
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        ipSecurityRestrictions: [for (range, i) in allowedIpRanges: {
          name: 'allow-${i}'
          action: 'Allow'
          ipAddressRange: range
        }]
      }
    }
    template: {
      containers: [
        {
          name: 'app'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat(dataKeyEnv, [
            { name: 'APP_ENV', value: appEnv }
            { name: 'AUTH_MODE', value: authMode }
            { name: 'ALLOW_LOCAL_AUTH', value: authMode == 'local' && appEnv != 'production' ? 'true' : 'false' }
            { name: 'SEED_TEST_DATA', value: string(effectiveSeed) }
            { name: 'ADMIN_EMAILS', value: adminEmails }
            { name: 'APP_VERSION', value: appVersion }
            { name: 'PLATFORM_NAME', value: appName }

            // SMB does not support SQLite's WAL mode reliably; use the rollback journal.
            { name: 'SQLITE_JOURNAL_MODE', value: 'DELETE' }
            { name: 'DATA_DIR', value: '/data' }
          ])
          volumeMounts: [{ volumeName: 'data', mountPath: '/data' }]
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 30 }
            { type: 'Readiness', httpGet: { path: '/health', port: 8080 }, initialDelaySeconds: 5, periodSeconds: 10 }
          ]
        }
      ]
      volumes: [
        {
          name: 'data'
          storageType: 'AzureFile'
          storageName: envStorage.name
          // nobrl: Azure Files has no byte-range locks. Safe here because exactly one replica ever writes.
          mountOptions: 'dir_mode=0777,file_mode=0666,uid=1000,gid=1000,nobrl,mfsymlinks,cache=strict,nosharesock'
        }
      ]
      // SQLite allows one writer, so the app must never scale beyond a single replica.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
  dependsOn: [acrPull]
}

output acrName string = acr.name
output acrLoginServer string = acr.properties.loginServer
output appFqdn string = deployApp ? app!.properties.configuration.ingress.fqdn : ''
output storageAccount string = storage.name
