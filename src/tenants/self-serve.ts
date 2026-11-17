import { z } from "zod";
import type { PgMigrationDefinition, PgPool } from "../persistence/pg-pool.ts";
import { isAppHandleShape } from "../../plugins/chassis/src/dns-label.ts";
import { tenantSettingsSchema, type TenantSettings } from "./settings.ts";

export const externalOrgSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    handle: z.string().trim().toLowerCase().max(63).optional(),
  })
  .strip();

export type ExternalOrg = z.infer<typeof externalOrgSchema>;

const IDENTITY_KEYS = [
  "brandName",
  "handle",
  "orgSlug",
  "oidcClient",
  "allowedEmails",
  "slackBridgeToken",
  "partnerChatAccount",
  "serving",
] as const;

export function parseSelfServeSettings(raw: string | undefined): TenantSettings {
  if (!raw) return {};
  const parsed = tenantSettingsSchema.parse(JSON.parse(raw));
  const identity = IDENTITY_KEYS.filter((key) => parsed[key] !== undefined);
  if (identity.length) throw new Error(`self-serve tenant defaults may not set ${identity.join(", ")}`);
  return parsed;
}

const definer = `CREATE OR REPLACE FUNCTION qm_self_serve_tenant(issuer text, org text, brand text, handle text, defaults jsonb)
  RETURNS TABLE(tenant uuid, created boolean) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = %1$I, pg_temp AS $f$
  DECLARE found uuid;
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('qm-self-serve:' || $1 || chr(10) || $2, 0));
    SELECT o.tenant INTO found FROM tenant_external_orgs o WHERE o.issuer = $1 AND o.org_id = $2;
    IF found IS NOT NULL THEN
      RETURN QUERY SELECT found, false;
      RETURN;
    END IF;
    INSERT INTO tenants(settings) VALUES (coalesce($5, '{}'::jsonb) || jsonb_build_object('brandName', $3))
      RETURNING id INTO found;
    IF $4 IS NOT NULL AND qm_tenant_handle(jsonb_build_object('handle', $4)) IS NOT DISTINCT FROM $4 THEN
      BEGIN
        UPDATE tenants SET settings = settings || jsonb_build_object('handle', $4) WHERE id = found;
      EXCEPTION WHEN unique_violation THEN NULL;
      END;
    END IF;
    INSERT INTO tenant_external_orgs(issuer, org_id, tenant) VALUES ($1, $2, found);
    RETURN QUERY SELECT found, true;
  END $f$`;

export const TENANT_EXTERNAL_ORGS: PgMigrationDefinition = {
  id: "tenancy/self-serve/0001-external-orgs",
  statements: [
    `SET LOCAL lock_timeout = '5s'`,
    `CREATE TABLE IF NOT EXISTS tenant_external_orgs(
      issuer TEXT NOT NULL,
      org_id TEXT NOT NULL,
      tenant UUID NOT NULL UNIQUE REFERENCES tenants(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (issuer, org_id)
    )`,
    `ALTER TABLE tenant_external_orgs ENABLE ROW LEVEL SECURITY`,
    `DO $self_serve$ BEGIN EXECUTE format($sql$${definer}$sql$, current_schema()); END $self_serve$`,
  ],
};

export async function selfServeTenant(
  pg: Pick<PgPool, "q">,
  issuer: string,
  org: ExternalOrg,
  defaults: TenantSettings,
): Promise<{ tenant: string; created: boolean }> {
  const handle = org.handle && isAppHandleShape(org.handle) ? org.handle : null;
  const rows = await pg.q(
    "SELECT tenant::text AS tenant, created FROM qm_self_serve_tenant($1, $2, $3, $4, $5::jsonb)",
    [issuer, org.id, org.name, handle, JSON.stringify(defaults)],
  );
  const row = rows[0];
  if (typeof row?.tenant !== "string") throw new Error("self-serve tenant was not created");
  return { tenant: row.tenant, created: row.created === true };
}
