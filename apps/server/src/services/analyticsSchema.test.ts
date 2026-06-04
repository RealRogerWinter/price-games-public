/**
 * Schema-drift guard for the analytics tables.
 *
 * The hourly rollup, V2 dashboard queries, and the recordEvent ingest
 * path all read raw column names. A column rename or retype that's
 * missed at any of those callsites silently corrupts dashboards. This
 * test snapshots `PRAGMA table_info(...)` for the five load-bearing
 * analytics tables and fails on ANY column add/remove/retype that
 * doesn't update the inline expected schema.
 *
 * When this test fails, you have two choices:
 *   1. The schema change is intentional → update the expected schema
 *      below AND audit every consumer of the changed column. Common
 *      consumers: analyticsHourly.ts (rollup SQL), analyticsV2.ts
 *      (dashboard queries), eventLog.ts (UPSERT/INSERT shapes), and
 *      the docs in docs/ANALYTICS.md / docs/DATABASE.md.
 *   2. The schema change is accidental → revert it.
 *
 * The snapshot is INLINE not a fixture file because that surfaces the
 * intent and the consumer audit list at the same diff hunk in PR
 * review. A separate JSON snapshot file would let the schema change
 * sneak in as "auto-generated" with no review prompt.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createTestDb } from "../test/dbHelper";

let db: DatabaseType;

beforeEach(() => {
  db = createTestDb();
});

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function tableInfo(table: string): ColumnInfo[] {
  // SQLite's PRAGMA returns rows in column-definition order, which is
  // also the order callers reading by index expect. We sort by name
  // so a re-ordering of column DEFINITIONS doesn't trip the snapshot
  // — only true add/remove/retype does. Better-sqlite3 returns extra
  // fields (cid, hidden) we ignore here.
  return (
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<ColumnInfo & { cid: number }>
  )
    .map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      dflt_value: c.dflt_value,
      pk: c.pk,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe("analytics schema drift guard", () => {
  it("events table column shape is unchanged", () => {
    expect(tableInfo("events")).toMatchInlineSnapshot(`
      [
        {
          "dflt_value": null,
          "name": "browser",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "client_event_id",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "country",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "'unknown'",
          "name": "device_type",
          "notnull": 1,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "0",
          "name": "dnt",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "event_name",
          "notnull": 1,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "event_type",
          "notnull": 1,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "game_mode",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "game_session_id",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "id",
          "notnull": 0,
          "pk": 1,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "ip_hash",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "1",
          "name": "ip_salt_version",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "is_bot",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "is_synthetic",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "mp_room_code",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "os",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "path",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "properties",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "referrer",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "region",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "seq",
          "notnull": 0,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "session_id",
          "notnull": 1,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "tab_id",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "ts_client",
          "notnull": 0,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "ts_server",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "ua_hash",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "user_id",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "visitor_id",
          "notnull": 1,
          "pk": 0,
          "type": "TEXT",
        },
      ]
    `);
  });

  it("visitor_profile table column shape is unchanged", () => {
    expect(tableInfo("visitor_profile")).toMatchInlineSnapshot(`
      [
        {
          "dflt_value": null,
          "name": "current_session_id",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "current_session_started",
          "notnull": 0,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "dnt",
          "notnull": 0,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "ever_played",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "ever_registered",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "first_country",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "first_device_type",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "first_seen_at",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "is_bot",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "last_seen_at",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "last_session_bounced",
          "notnull": 0,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "total_events",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "total_games_completed",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "total_games_started",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "total_page_views",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "total_sessions",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "total_time_ms",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "user_id",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "visitor_id",
          "notnull": 0,
          "pk": 1,
          "type": "TEXT",
        },
      ]
    `);
  });

  it("visitor_aliases table column shape is unchanged", () => {
    expect(tableInfo("visitor_aliases")).toMatchInlineSnapshot(`
      [
        {
          "dflt_value": null,
          "name": "merged_at",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "user_id",
          "notnull": 1,
          "pk": 2,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "visitor_id",
          "notnull": 1,
          "pk": 1,
          "type": "TEXT",
        },
      ]
    `);
  });

  it("analytics_sessions table column shape is unchanged", () => {
    expect(tableInfo("analytics_sessions")).toMatchInlineSnapshot(`
      [
        {
          "dflt_value": null,
          "name": "bounced",
          "notnull": 0,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "browser",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "country",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "'unknown'",
          "name": "device_type",
          "notnull": 1,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "ended_at",
          "notnull": 0,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "entry_path",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "entry_referrer",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "entry_utm_campaign",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "entry_utm_medium",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "entry_utm_source",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "1",
          "name": "event_count",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "exit_path",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "0",
          "name": "games_completed",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "games_started",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "id",
          "notnull": 0,
          "pk": 1,
          "type": "TEXT",
        },
        {
          "dflt_value": "0",
          "name": "is_bot",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "is_returning",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "last_event_at",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "last_utm_source",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "0",
          "name": "login_occurred",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "os",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": "0",
          "name": "page_view_count",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "signup_occurred",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "started_at",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "user_id",
          "notnull": 0,
          "pk": 0,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "visitor_id",
          "notnull": 1,
          "pk": 0,
          "type": "TEXT",
        },
      ]
    `);
  });

  it("analytics_hourly table column shape is unchanged", () => {
    expect(tableInfo("analytics_hourly")).toMatchInlineSnapshot(`
      [
        {
          "dflt_value": "'unknown'",
          "name": "acquisition_source",
          "notnull": 1,
          "pk": 5,
          "type": "TEXT",
        },
        {
          "dflt_value": "0",
          "name": "bounced_sessions",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "'unknown'",
          "name": "country",
          "notnull": 1,
          "pk": 4,
          "type": "TEXT",
        },
        {
          "dflt_value": null,
          "name": "device_type",
          "notnull": 1,
          "pk": 2,
          "type": "TEXT",
        },
        {
          "dflt_value": "0",
          "name": "events_count",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "games_completed",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "games_started",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "hour_bucket",
          "notnull": 1,
          "pk": 1,
          "type": "INTEGER",
        },
        {
          "dflt_value": null,
          "name": "is_logged_in",
          "notnull": 1,
          "pk": 3,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "logins",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "new_sessions",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "page_views",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "sessions",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
        {
          "dflt_value": "0",
          "name": "signups",
          "notnull": 1,
          "pk": 0,
          "type": "INTEGER",
        },
      ]
    `);
  });
});
