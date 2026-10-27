# Fabric notebook: load every Neumann platform into the lakehouse (bronze layer).
#
# One notebook, all platforms. Each platform exposes the same Data Export API
# (docs/PLATFORM-STANDARD.md section 14), so onboarding a new platform means adding one
# entry to PLATFORMS below — no new code.
#
# Setup: attach your lakehouse as the notebook's default, store each platform's API key in
# Azure Key Vault, and schedule this notebook (e.g. hourly) from a Fabric pipeline.
#
# Result: one Delta table per platform dataset, named bronze_<platform>_<dataset>, upserted by
# id and kept in step with deletions, plus bronze_ingest_control (watermarks) and
# bronze_ingest_log (what each run did).
#
# STATUS: written against the API contract and not yet run in a Fabric workspace.
# Expect to adjust the Key Vault call and table names on the first run.

import json
import time
from datetime import datetime, timedelta, timezone

import requests
from delta.tables import DeltaTable
from pyspark.sql import functions as F
from pyspark.sql.types import StringType, StructField, StructType

# ---- configuration ------------------------------------------------------------------------

KEY_VAULT_URL = "https://<your-keyvault>.vault.azure.net/"

PLATFORMS = [
    {
        "name": "car_booking",                                   # used in table names (letters, digits, _)
        "base_url": "https://<car-booking-fqdn>/api/export/v1",
        "key_secret": "car-booking-data-api-key",                # Key Vault secret holding the API key
    },
    # {"name": "next_platform", "base_url": "https://.../api/export/v1", "key_secret": "..."},
]

PAGE_SIZE = 2000
OVERLAP = timedelta(minutes=5)   # re-read a little before the watermark; upserts make this safe
FULL_REFRESH = False             # True = ignore watermarks and reload everything

# ---- helpers -------------------------------------------------------------------------------

CONTROL = "bronze_ingest_control"
LOG = "bronze_ingest_log"


def get_secret(name):
    # Fabric notebook utility; replace if your workspace uses a different secret mechanism.
    return notebookutils.credentials.getSecret(KEY_VAULT_URL, name)  # noqa: F821


def api_get(session, url, params=None, retries=4):
    for attempt in range(retries):
        r = session.get(url, params=params, timeout=60)
        if r.status_code == 200:
            return r.json()
        if r.status_code in (429, 500, 502, 503, 504) and attempt < retries - 1:
            time.sleep(2 ** attempt * 2)
            continue
        raise RuntimeError(f"{url} -> HTTP {r.status_code}: {r.text[:300]}")


def table_exists(name):
    return spark.catalog.tableExists(name)  # noqa: F821


def get_watermark(platform, dataset):
    if FULL_REFRESH or not table_exists(CONTROL):
        return None
    row = (spark.table(CONTROL)  # noqa: F821
           .where((F.col("platform") == platform) & (F.col("dataset") == dataset))
           .select("watermark").first())
    return row["watermark"] if row else None


def save_watermark(platform, dataset, watermark):
    df = spark.createDataFrame([(platform, dataset, watermark)], ["platform", "dataset", "watermark"])  # noqa: F821
    if not table_exists(CONTROL):
        df.write.format("delta").saveAsTable(CONTROL)
        return
    (DeltaTable.forName(spark, CONTROL).alias("t")  # noqa: F821
     .merge(df.alias("s"), "t.platform = s.platform AND t.dataset = s.dataset")
     .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute())


def to_row(record, columns):
    # Bronze keeps every value as a string (or null) so schema drift never breaks a load.
    return tuple(None if record.get(c) is None else str(record.get(c)) for c in columns)


def upsert(table, df):
    if not table_exists(table):
        df.write.format("delta").saveAsTable(table)
        return
    (DeltaTable.forName(spark, table).alias("t")  # noqa: F821
     .merge(df.alias("s"), "t.id = s.id")
     .whenMatchedUpdateAll().whenNotMatchedInsertAll().execute())


def ingest_dataset(session, platform, base_url, ds, run_started):
    name, columns = ds["name"], ds["columns"]
    table = f"bronze_{platform}_{name}"
    since = get_watermark(platform, name)
    schema = StructType([StructField(c, StringType(), True) for c in columns] +
                        [StructField("_ingested_at", StringType(), True)])

    cursor, total = "", 0
    while True:
        params = {"limit": PAGE_SIZE, "cursor": cursor}
        if since:
            params["updatedSince"] = since
        page = api_get(session, f"{base_url}/{name}", params)
        if page["count"]:
            stamp = datetime.now(timezone.utc).isoformat()
            rows = [to_row(r, columns) + (stamp,) for r in page["data"]]
            upsert(table, spark.createDataFrame(rows, schema))  # noqa: F821
            total += page["count"]
        if not page["hasMore"]:
            break
        cursor = page["nextCursor"]

    # Next run starts shortly before this run began, so nothing changed mid-run is missed.
    save_watermark(platform, name, (run_started - OVERLAP).strftime("%Y-%m-%dT%H:%M:%S.000Z"))
    return table, total


def apply_deletions(platform):
    # deleted_records says which ids were removed in the source; remove them from the lake tables.
    deleted = f"bronze_{platform}_deleted_records"
    if not table_exists(deleted):
        return
    # SQLite can reuse the id of a deleted last row, so only delete a lake row that has not been
    # written since the deletion (its updated_at is older than deleted_at).
    latest = (spark.table(deleted).groupBy("entity", "entity_id")  # noqa: F821
              .agg(F.max("deleted_at").alias("deleted_at")).collect())
    for r in latest:
        target = f"bronze_{platform}_{r['entity']}"
        if table_exists(target):
            spark.sql(  # noqa: F821
                f"DELETE FROM {target} WHERE id = '{r['entity_id']}' AND updated_at < '{r['deleted_at']}'")


# ---- run -----------------------------------------------------------------------------------

log_rows = []
for p in PLATFORMS:
    session = requests.Session()
    session.headers["Authorization"] = "Bearer " + get_secret(p["key_secret"])
    manifest = api_get(session, f"{p['base_url']}/manifest")
    run_started = datetime.fromisoformat(manifest["serverTime"].replace("Z", "+00:00"))
    print(f"{p['name']}: schema v{manifest['schemaVersion']}, app version {manifest['version']}")

    # deleted_records goes first so a deletion is applied after the rows it refers to are loaded.
    datasets = sorted(manifest["datasets"], key=lambda d: d["name"] == "deleted_records")
    for ds in datasets:
        started = datetime.now(timezone.utc).isoformat()
        try:
            table, n = ingest_dataset(session, p["name"], p["base_url"], ds, run_started)
            print(f"  {table}: {n} rows")
            log_rows.append((p["name"], ds["name"], started, n, "ok", None))
        except Exception as e:  # keep going: one failing dataset must not block the rest
            print(f"  {ds['name']}: FAILED {e}")
            log_rows.append((p["name"], ds["name"], started, 0, "failed", str(e)[:500]))
    apply_deletions(p["name"])

log_df = spark.createDataFrame(  # noqa: F821
    log_rows, ["platform", "dataset", "started_at", "rows", "status", "error"])
log_df.write.format("delta").mode("append").saveAsTable(LOG)

failed = [r for r in log_rows if r[4] == "failed"]
if failed:
    raise RuntimeError(f"{len(failed)} dataset(s) failed — see {LOG}")
