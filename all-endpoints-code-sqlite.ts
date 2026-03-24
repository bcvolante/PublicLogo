/**
 * SQLite implementation of the same endpoint logic for mobile / offline.
 * Uses the sync SQLite schema (color-sync-*.sqlite). Same method names and
 * signatures as AllEndpointsCode (Prisma) so you can swap backend for mobile.
 *
 * Usage (mobile): pass a DB adapter from createExpoSqliteAdapter(expoDb).
 * The adapter must expose: prepare(sql) -> { all(...params), get(...params), run(...params) }
 * returning Promises for async drivers (expo-sqlite).
 *
 * Regions: if the DB has no "regions" table, filtersRegions() returns distinct
 * region_id from color_region (id and name both set to region_id).
 */

import type { SqliteDbLike, SqliteRunResult } from './expoSqliteAdapter';
import type {
  BrandFilterDto,
  ModelFilterDto,
  YearFilterDto,
  ColorGroupFilterDto,
  ColorFilterDto,
  CreateClientColorDto,
  UpdateClientColorDto,
  CreateUpdateMaterialPriceDto,
  UpdateMarginDto,
} from './all-endpoints-code';

// Helpers (same as Prisma version)
function combineRGB(rgbList: string[]): string | null {
  if (!rgbList.length) return null;
  const colors: number[][] = rgbList
    .map((r) => r.split(/[, ]+/).map((n) => Number(n)))
    .filter((c) => c.length === 3 && c.every((n) => !isNaN(n)));
  if (!colors.length) return null;
  const total = colors.length;
  const combined = [0, 1, 2].map((i) =>
    Math.round(colors.reduce((sum, c) => sum + c[i], 0) / total),
  );
  return combined.join(' ');
}

const SOLID_EQUIVALENTS = new Set(['Alternate Base', 'Disorienter', 'Extender']);
const PEARL_EQUIVALENTS = new Set(['Xirallic']);

function normalizeTonerType(type: string): string {
  if (SOLID_EQUIVALENTS.has(type)) return 'Solid';
  if (PEARL_EQUIVALENTS.has(type)) return 'Pearl';
  return type;
}

function sqlLikeEscape(term: string): string {
  return term.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** SQLite-backed implementation – same method names as AllEndpointsCode (Prisma). */
export class AllEndpointsCodeSqlite {
  constructor(private readonly db: SqliteDbLike) {}

  private async all<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.prepare(sql).all(...params);
    return (result as T[]) ?? [];
  }

  private async get<T = unknown>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const row = await this.db.prepare(sql).get(...params);
    return row as T | undefined;
  }

  private async run(sql: string, params: unknown[] = []): Promise<SqliteRunResult> {
    return await this.db.prepare(sql).run(...params);
  }

  private async hasTable(name: string): Promise<boolean> {
    const row = await this.get<{ n: number }>(
      `SELECT 1 as n FROM sqlite_master WHERE type='table' AND name=?`,
      [name],
    );
    return !!row;
  }

  async filtersRegions(): Promise<{ id: string; name: string }[]> {
    if (await this.hasTable('regions')) {
      return await this.all(
        `SELECT id, name FROM regions WHERE is_deleted = 0 AND is_active = 1 ORDER BY order_by ASC`,
      );
    }
    const rows = await this.all<{ region_id: string }>(
      `SELECT DISTINCT region_id FROM color_region WHERE is_deleted = 0 AND is_active = 1 AND region_id IS NOT NULL`,
    );
    return rows.map((r) => ({ id: r.region_id, name: r.region_id }));
  }

  async filtersBrands(filter: BrandFilterDto) {
    let sql = `SELECT DISTINCT m.id, m.name, m.image_path FROM make m
      INNER JOIN color c ON c.make_id = m.id AND c.is_active = 1 AND c.is_deleted = 0`;
    const params: unknown[] = [];
    if (filter.color_group_id) {
      sql += ` INNER JOIN color_family_list cfl ON cfl.color_id = c.id AND cfl.color_family_id = ?`;
      params.push(filter.color_group_id.toUpperCase());
    }
    if (filter.region_id) {
      sql += ` INNER JOIN color_region cr ON cr.color_id = c.id AND cr.region_id = ? AND cr.is_deleted = 0`;
      params.push(filter.region_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM color_code cc WHERE cc.color_id = c.id AND cc.oem_color_code LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM color_description cd WHERE cd.color_id = c.id AND cd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    sql += ` WHERE m.is_active = 1 AND m.is_deleted = 0 ORDER BY m.name ASC`;
    return await this.all(sql, params);
  }

  async filtersClientBrands(id: string, filter: BrandFilterDto) {
    let sql = `SELECT DISTINCT m.id, m.name, m.image_path FROM make m
      INNER JOIN client_color cc ON cc.make_id = m.id AND cc.is_active = 1 AND cc.is_deleted = 0 AND cc.created_by = ?`;
    const params: unknown[] = [id];
    if (filter.color_group_id) {
      sql += ` INNER JOIN client_color_family_list ccfl ON ccfl.color_id = cc.id AND ccfl.color_family_id = ?`;
      params.push(filter.color_group_id.toUpperCase());
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM client_color_code ccc WHERE ccc.color_id = cc.id AND ccc.oem_color_code LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM client_color_description ccd WHERE ccd.color_id = cc.id AND ccd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    sql += ` ORDER BY m.name ASC`;
    return await this.all(sql, params);
  }

  async filtersModels(filter: ModelFilterDto) {
    let sql = `SELECT DISTINCT mod.id, mod.name FROM model mod
      INNER JOIN color_model cm ON cm.model_id = mod.id
      INNER JOIN color c ON c.id = cm.color_id AND c.is_active = 1 AND c.is_deleted = 0 AND c.make_id = ?`;
    const params: unknown[] = [filter.brand_id];
    if (filter.color_group_id) {
      sql += ` INNER JOIN color_family_list cfl ON cfl.color_id = c.id AND cfl.color_family_id = ?`;
      params.push(filter.color_group_id.toUpperCase());
    }
    if (filter.region_id) {
      sql += ` INNER JOIN color_region cr ON cr.color_id = c.id AND cr.region_id = ? AND cr.is_deleted = 0`;
      params.push(filter.region_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM color_code cc WHERE cc.color_id = c.id AND cc.oem_color_code LIKE ? ESCAPE '\\')
        OR EXISTS (SELECT 1 FROM color_description cd WHERE cd.color_id = c.id AND cd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    sql += ` WHERE mod.is_active = 1 AND mod.is_deleted = 0 ORDER BY mod.name ASC`;
    return await this.all(sql, params);
  }

  async filtersClientModels(id: string, filter: ModelFilterDto) {
    const params: unknown[] = [id, filter.brand_id];
    let sql = `SELECT DISTINCT ccm.model_name FROM client_color_model ccm
      INNER JOIN client_color cc ON cc.id = ccm.color_id AND cc.created_by = ? AND cc.is_active = 1 AND cc.is_deleted = 0 AND cc.make_id = ?`;
    if (filter.color_group_id) {
      sql += ` INNER JOIN client_color_family_list ccfl ON ccfl.color_id = cc.id AND ccfl.color_family_id = ?`;
      params.push(filter.color_group_id.toUpperCase());
    }
    if (filter.region_id) {
      sql += ` INNER JOIN color_region cr ON cr.color_id = cc.id AND cr.region_id = ? AND cr.is_deleted = 0`;
      params.push(filter.region_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM client_color_code ccc WHERE ccc.color_id = cc.id AND ccc.oem_color_code LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM client_color_description ccd WHERE ccd.color_id = cc.id AND ccd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    sql += ` ORDER BY ccm.model_name ASC`;
    const rows = await this.all<{ model_name: string }>(sql, params);
    return rows.map((r) => ({ model_name: r.model_name }));
  }

  async filtersYears(filter: YearFilterDto): Promise<number[]> {
    let sql = `SELECT c.year_first, c.year_last FROM color c
      INNER JOIN color_model cm ON cm.color_id = c.id AND cm.model_id = ?
      WHERE c.is_active = 1 AND c.is_deleted = 0 AND c.make_id = ?`;
    const params: unknown[] = [filter.model_id, filter.brand_id];
    if (filter.color_group_id) {
      sql += ` AND EXISTS (SELECT 1 FROM color_family_list cfl WHERE cfl.color_id = c.id AND cfl.color_family_id = ?)`;
      params.push(filter.color_group_id.toUpperCase());
    }
    if (filter.region_id) {
      sql += ` AND EXISTS (SELECT 1 FROM color_region cr WHERE cr.color_id = c.id AND cr.region_id = ? AND cr.is_deleted = 0)`;
      params.push(filter.region_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM color_code cc WHERE cc.color_id = c.id AND cc.oem_color_code LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM color_description cd WHERE cd.color_id = c.id AND cd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    const rows = await this.all<{ year_first: number | null; year_last: number | null }>(
      sql,
      params,
    );
    const yearsSet = new Set<number>();
    for (const r of rows) {
      const start = r.year_first ?? 0;
      const end = r.year_last ?? start;
      for (let y = start; y <= end; y++) yearsSet.add(y);
    }
    return Array.from(yearsSet).sort((a, b) => a - b);
  }

  async filtersClientYears(id: string, filter: YearFilterDto): Promise<number[]> {
    let sql = `SELECT cc.year_first, cc.year_last FROM client_color cc
      INNER JOIN client_color_model ccm ON ccm.color_id = cc.id AND ccm.model_name = ?
      WHERE cc.is_active = 1 AND cc.is_deleted = 0 AND cc.make_id = ? AND cc.created_by = ?`;
    const params: unknown[] = [filter.model_id, filter.brand_id, id];
    if (filter.color_group_id) {
      sql += ` AND EXISTS (SELECT 1 FROM client_color_family_list ccfl WHERE ccfl.color_id = cc.id AND ccfl.color_family_id = ?)`;
      params.push(filter.color_group_id.toUpperCase());
    }
    if (filter.region_id) {
      sql += ` AND EXISTS (SELECT 1 FROM color_region cr WHERE cr.color_id = cc.id AND cr.region_id = ? AND cr.is_deleted = 0)`;
      params.push(filter.region_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM client_color_code ccc WHERE ccc.color_id = cc.id AND ccc.oem_color_code LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM client_color_description ccd WHERE ccd.color_id = cc.id AND ccd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    const rows = await this.all<{ year_first: number | null; year_last: number | null }>(
      sql,
      params,
    );
    const yearsSet = new Set<number>();
    for (const r of rows) {
      const start = r.year_first ?? 0;
      const end = r.year_last ?? start;
      for (let y = start; y <= end; y++) yearsSet.add(y);
    }
    return Array.from(yearsSet).sort((a, b) => a - b);
  }

  async filtersColorGroups(filter: ColorGroupFilterDto) {
    const year = filter.year ? Number(filter.year) : undefined;
    let sql = `SELECT DISTINCT cf.id, cf.name, cf.rgb FROM color_family cf
      INNER JOIN color_family_list cfl ON cfl.color_family_id = cf.id
      INNER JOIN color c ON c.id = cfl.color_id AND c.is_active = 1 AND c.is_deleted = 0`;
    const params: unknown[] = [];
    if (filter.brand_id) {
      sql += ` AND c.make_id = ?`;
      params.push(filter.brand_id);
    }
    if (filter.model_id) {
      sql += ` AND EXISTS (SELECT 1 FROM color_model cm WHERE cm.color_id = c.id AND cm.model_id = ?)`;
      params.push(filter.model_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM color_code cc WHERE cc.color_id = c.id AND cc.oem_color_code LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM color_description cd WHERE cd.color_id = c.id AND cd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    if (year !== undefined) {
      sql += ` AND c.year_first <= ? AND c.year_last >= ?`;
      params.push(year, year);
    }
    sql += ` WHERE cf.is_active = 1 AND cf.is_deleted = 0 ORDER BY cf.name ASC`;
    return await this.all(sql, params);
  }

  async filtersClientColorGroups(id: string, filter: ColorGroupFilterDto) {
    const year = filter.year ? Number(filter.year) : undefined;
    let sql = `SELECT DISTINCT cf.id, cf.name, cf.rgb FROM color_family cf
      INNER JOIN client_color_family_list ccfl ON ccfl.color_family_id = cf.id
      INNER JOIN client_color cc ON cc.id = ccfl.color_id AND cc.is_active = 1 AND cc.is_deleted = 0 AND cc.created_by = ?`;
    const params: unknown[] = [id];
    if (filter.brand_id) {
      sql += ` AND cc.make_id = ?`;
      params.push(filter.brand_id);
    }
    if (filter.model_id) {
      sql += ` AND EXISTS (SELECT 1 FROM client_color_model ccm WHERE ccm.color_id = cc.id AND ccm.model_name = ?)`;
      params.push(filter.model_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      sql += ` AND (EXISTS (SELECT 1 FROM client_color_code ccc WHERE ccc.color_id = cc.id AND ccc.oem_color_code LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM client_color_description ccd WHERE ccd.color_id = cc.id AND ccd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    if (year !== undefined) {
      sql += ` AND cc.year_first <= ? AND cc.year_last >= ?`;
      params.push(year, year);
    }
    sql += ` WHERE cf.is_active = 1 AND cf.is_deleted = 0 ORDER BY cf.name ASC`;
    return await this.all(sql, params);
  }

  async regionClientDropdown() {
    return this.filtersRegions();
  }

  async companyClientDropdown() {
    if (!(await this.hasTable('companies')))
      return [];
    return await this.all(
      `SELECT id, name FROM companies WHERE is_deleted = 0 AND is_active = 1 ORDER BY created_at DESC`,
    );
  }

  async makeClientActive() {
    const makes = await this.all<Record<string, unknown> & { id: string }>(
      `SELECT * FROM make WHERE is_deleted = 0 AND is_active = 1 ORDER BY name ASC`,
    );
    return Promise.all(makes.map(async (m) => ({
      ...m,
      make_part: await this.all(
        `SELECT mp.*, cp.id as car_parts_id, cp.name as car_parts_name, cp.polygon, cp.is_active as car_parts_is_active, cp.is_deleted as car_parts_is_deleted, cp.created_at as car_parts_created_at, cp.updated_at as car_parts_updated_at
         FROM make_part mp LEFT JOIN car_parts cp ON cp.id = mp.car_part_id WHERE mp.make_id = ?`,
        [m.id],
      ),
    })));
  }

  async variantTypeClientActive() {
    return await this.all(
      `SELECT * FROM variant_type WHERE is_deleted = 0 AND is_active = 1 ORDER BY created_at DESC`,
    );
  }

  async systemTypeClientActive() {
    return await this.all(
      `SELECT * FROM system_type WHERE is_deleted = 0 AND is_active = 1 ORDER BY created_at DESC`,
    );
  }

  async colorFamilyClientActive() {
    return await this.all(
      `SELECT * FROM color_family WHERE is_deleted = 0 AND is_active = 1 ORDER BY created_at ASC`,
    );
  }

  async colorClientCreate(dto: CreateClientColorDto) {
    const id = `client-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    await this.run(
      `INSERT INTO client_color (id, year_first, year_last, rgb_value, make_id, created_by, updated_by, is_active, is_deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))`,
      [
        id,
        dto.year_first ?? 2000,
        dto.year_last ?? new Date().getFullYear(),
        dto.rgb_value ?? '#000000',
        dto.make_id,
        dto.created_by,
        dto.updated_by,
      ],
    );
    const colorId = id;
    for (const f of dto.families ?? []) {
      await this.run(
        `INSERT INTO client_color_family_list (id, color_id, color_family_id, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [`cfl-${colorId}-${f.color_family_id}`, colorId, f.color_family_id],
      );
    }
    for (const c of dto.codes ?? []) {
      await this.run(
        `INSERT INTO client_color_code (id, color_id, oem_color_code, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [`ccc-${colorId}-${c.oem_color_code}`, colorId, c.oem_color_code],
      );
    }
    for (const d of dto.descriptions ?? []) {
      await this.run(
        `INSERT INTO client_color_description (id, color_id, color_description, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [`ccd-${colorId}-${d.color_description.slice(0, 20)}`, colorId, d.color_description],
      );
    }
    for (const layer of dto.layers ?? []) {
      const layerId = `ccl-${colorId}-${layer.layer_number ?? 1}-${Date.now()}`;
      await this.run(
        `INSERT INTO client_color_layer (id, color_id, color_version, system_type_id, layer_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [
          layerId,
          colorId,
          layer.color_version ?? null,
          layer.system_type_id ?? null,
          layer.layer_number ?? 1,
        ],
      );
      for (const m of layer.materials ?? []) {
        await this.run(
          `INSERT INTO client_color_material_list (id, color_layer_id, material_id, quantity, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
          [`ccml-${layerId}-${m.material_id}`, layerId, m.material_id, m.quantity],
        );
      }
    }
    return { id: colorId };
  }

  async colorClientUpdate(id: string, dto: UpdateClientColorDto) {
    const existing = await this.get<{ id: string }>(
      `SELECT id FROM client_color WHERE id = ? AND is_deleted = 0`,
      [id],
    );
    if (!existing) throw new Error(`Client color ${id} not found`);
    await this.run(
      `UPDATE client_color SET year_first = ?, year_last = ?, rgb_value = ?, make_id = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`,
      [
        dto.year_first,
        dto.year_last,
        dto.rgb_value,
        dto.make_id,
        dto.updated_by,
        id,
      ],
    );
    await this.run(`DELETE FROM client_color_material_list WHERE color_layer_id IN (SELECT id FROM client_color_layer WHERE color_id = ?)`, [id]);
    await this.run(`DELETE FROM client_color_layer WHERE color_id = ?`, [id]);
    await this.run(`DELETE FROM client_color_family_list WHERE color_id = ?`, [id]);
    await this.run(`DELETE FROM client_color_code WHERE color_id = ?`, [id]);
    await this.run(`DELETE FROM client_color_description WHERE color_id = ?`, [id]);
    for (const f of dto.families ?? []) {
      await this.run(
        `INSERT INTO client_color_family_list (id, color_id, color_family_id, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [`cfl-${id}-${f.color_family_id}`, id, f.color_family_id],
      );
    }
    for (const c of dto.codes ?? []) {
      await this.run(
        `INSERT INTO client_color_code (id, color_id, oem_color_code, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [`ccc-${id}-${c.oem_color_code}`, id, c.oem_color_code],
      );
    }
    for (const d of dto.descriptions ?? []) {
      await this.run(
        `INSERT INTO client_color_description (id, color_id, color_description, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [`ccd-${id}-${d.color_description.slice(0, 20)}`, id, d.color_description],
      );
    }
    for (const layer of dto.layers ?? []) {
      const layerId = `ccl-${id}-${layer.layer_number ?? 1}-${Date.now()}`;
      await this.run(
        `INSERT INTO client_color_layer (id, color_id, color_version, system_type_id, layer_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
        [
          layerId,
          id,
          layer.color_version ?? null,
          layer.system_type_id ?? null,
          layer.layer_number ?? 1,
        ],
      );
      for (const m of layer.materials ?? []) {
        await this.run(
          `INSERT INTO client_color_material_list (id, color_layer_id, material_id, quantity, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
          [`ccml-${layerId}-${m.material_id}`, layerId, m.material_id, m.quantity],
        );
      }
    }
    return { id };
  }

  async colorClientRemove(id: string) {
    await this.run(
      `UPDATE client_color SET is_deleted = 1, is_active = 0, updated_at = datetime('now') WHERE id = ?`,
      [id],
    );
    return { id };
  }

  async colorClientSystemType(color_id: string, is_variant: boolean) {
    const rows = await this.all<{
      is_variant: number;
      color_id: string | null;
      color_variant_id: string | null;
      system_type_id: string | null;
    }>(
      is_variant
        ? `SELECT is_variant, color_id, color_variant_id, system_type_id FROM color_layer WHERE is_variant = 1 AND color_variant_id = ?`
        : `SELECT is_variant, color_id, color_variant_id, system_type_id FROM color_layer WHERE is_variant = 0 AND color_id = ?`,
      [color_id],
    );
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        const resolved = is_variant ? r.color_variant_id : r.color_id;
        if (!resolved || !r.system_type_id) return false;
        const key = `${r.is_variant}-${resolved}-${r.system_type_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => ({
        is_variant: Boolean(r.is_variant),
        color_id: (is_variant ? r.color_variant_id : r.color_id) ?? '',
        system_type_id: r.system_type_id ?? '',
      }));
  }

  async colorClientColorVersion(
    color_id: string,
    is_variant: boolean,
    system_type_id: string,
  ) {
    const rows = await this.all<{
      is_variant: number;
      color_id: string | null;
      color_variant_id: string | null;
      color_version: string | null;
      system_type_id: string | null;
    }>(
      `SELECT is_variant, color_id, color_variant_id, date(color_version) as color_version, system_type_id FROM color_layer WHERE system_type_id = ? AND ${is_variant ? 'is_variant = 1 AND color_variant_id = ?' : 'is_variant = 0 AND color_id = ?'}`,
      [system_type_id, color_id],
    );
    const seen = new Set<string>();
    return rows
      .filter((r) => {
        const resolved = is_variant ? r.color_variant_id : r.color_id;
        if (!resolved) return false;
        const cv = r.color_version ?? new Date().toISOString().split('T')[0];
        const key = `${r.is_variant}-${resolved}-${cv}-${r.system_type_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => ({
        is_variant: Boolean(r.is_variant),
        color_id: (is_variant ? r.color_variant_id : r.color_id) ?? '',
        color_version: r.color_version ?? new Date().toISOString().split('T')[0],
        system_type_id: r.system_type_id ?? '',
      }));
  }

  async colorClientLayer(
    color_id: string,
    is_variant: boolean,
    system_type_id: string,
    color_version: string,
  ) {
    const rows = await this.all<{
      is_variant: number;
      color_id: string | null;
      color_variant_id: string | null;
      color_version: string | null;
      system_type_id: string | null;
      layer_number: number | null;
    }>(
      `SELECT is_variant, color_id, color_variant_id, date(color_version) as color_version, system_type_id, layer_number FROM color_layer
       WHERE system_type_id = ? AND date(color_version) = date(?) AND ${is_variant ? 'is_variant = 1 AND color_variant_id = ?' : 'is_variant = 0 AND color_id = ?'}`,
      [system_type_id, color_version, color_id],
    );
    return rows.map((r) => ({
      is_variant: Boolean(r.is_variant),
      color_id: (is_variant ? r.color_variant_id : r.color_id) ?? '',
      color_version: r.color_version ?? color_version,
      system_type_id: r.system_type_id ?? '',
      layer_number: r.layer_number ?? 0,
    }));
  }

  async colorClientFormula(
    color_id: string,
    is_variant: boolean,
    system_type_id?: string | null,
    color_version?: string | null,
    layer_number?: number | null,
  ) {
    let sql = `SELECT id, color_id, color_variant_id, date(color_version) as color_version, system_type_id, layer_number, is_variant FROM color_layer WHERE is_variant = ? AND ${is_variant ? 'color_variant_id' : 'color_id'} = ?`;
    const params: unknown[] = [is_variant ? 1 : 0, color_id];
    if (system_type_id) {
      sql += ` AND system_type_id = ?`;
      params.push(system_type_id);
    }
    if (color_version) {
      sql += ` AND date(color_version) = date(?)`;
      params.push(color_version);
    }
    if (typeof layer_number === 'number') {
      sql += ` AND layer_number = ?`;
      params.push(layer_number);
    }
    const rows = await this.all<{
      id: string;
      color_id: string | null;
      color_variant_id: string | null;
      color_version: string | null;
      system_type_id: string | null;
      layer_number: number | null;
      is_variant: number;
    }>(sql, params);
    return Promise.all(rows.map(async (r) => {
      const materials = await this.all<{ material_id: string; quantity: number }>(
        `SELECT material_id, quantity FROM color_material_list WHERE color_layer_id = ?`,
        [r.id],
      );
      return {
        id: r.id,
        color_id: is_variant ? r.color_variant_id : r.color_id,
        color_version: r.color_version ?? null,
        system_type_id: r.system_type_id ?? '',
        layer_number: r.layer_number ?? 0,
        is_variant: Boolean(r.is_variant),
        materials: materials.map((m) => ({ material_id: m.material_id, quantity: m.quantity })),
      };
    }));
  }

  async colorClientClientFormula(
    id: string,
    color_id: string,
    system_type_id?: string | null,
    color_version?: string | null,
    layer_number?: number | null,
  ) {
    let sql = `SELECT ccl.id, ccl.color_id, date(ccl.color_version) as color_version, ccl.system_type_id, ccl.layer_number FROM client_color_layer ccl
      INNER JOIN client_color cc ON cc.id = ccl.color_id AND cc.created_by = ? WHERE ccl.color_id = ?`;
    const params: unknown[] = [id, color_id];
    if (system_type_id) {
      sql += ` AND ccl.system_type_id = ?`;
      params.push(system_type_id);
    }
    if (color_version) {
      sql += ` AND date(ccl.color_version) = date(?)`;
      params.push(color_version);
    }
    if (typeof layer_number === 'number') {
      sql += ` AND ccl.layer_number = ?`;
      params.push(layer_number);
    }
    const rows = await this.all<{
      id: string;
      color_id: string;
      color_version: string | null;
      system_type_id: string | null;
      layer_number: number | null;
    }>(sql, params);
    return Promise.all(rows.map(async (r) => {
      const materials = await this.all<{ material_id: string; quantity: number }>(
        `SELECT material_id, quantity FROM client_color_material_list WHERE color_layer_id = ?`,
        [r.id],
      );
      return {
        id: r.id,
        color_id: r.color_id,
        color_version: r.color_version ?? null,
        system_type_id: r.system_type_id ?? '',
        layer_number: r.layer_number ?? 0,
        materials: materials.map((m) => ({ material_id: m.material_id, quantity: m.quantity })),
      };
    }));
  }

  async colorClientMaterial(formula_id: string) {
    const rows = await this.all<{
      material_id: string;
      quantity: number | null;
      m_id: string;
      m_name: string | null;
      m_description: string | null;
      m_specific_gravity: number | null;
    }>(
      `SELECT cml.material_id, cml.quantity, m.id as m_id, m.name as m_name, m.description as m_description, m.specific_gravity as m_specific_gravity
       FROM color_material_list cml LEFT JOIN material m ON m.id = cml.material_id WHERE cml.color_layer_id = ?`,
      [formula_id],
    );
    return rows
      .filter((r) => r.m_id)
      .map((r) => ({
        id: r.m_id,
        name: r.m_name ?? '',
        description: r.m_description ?? '',
        specific_gravity: r.m_specific_gravity ?? 0,
        quantity: r.quantity ?? 0,
      }));
  }

  async colorClientView(userId: string, colorId: string) {
    let actualColorId = colorId;
    const color = await this.get<{ id: string }>(`SELECT id FROM color WHERE id = ?`, [colorId]);
    if (!color) {
      const variant = await this.get<{ color_id: string }>(
        `SELECT color_id FROM color_variant WHERE id = ?`,
        [colorId],
      );
      if (!variant) throw new Error(`Color with id ${colorId} not found`);
      actualColorId = variant.color_id;
    }
    const existing = await this.get<{ id: string; view_count: number }>(
      `SELECT id, view_count FROM color_view WHERE color_id = ?`,
      [actualColorId],
    );
    if (existing) {
      await this.run(
        `UPDATE color_view SET view_count = view_count + 1, created_at = datetime('now') WHERE id = ?`,
        [existing.id],
      );
    } else {
      await this.run(
        `INSERT INTO color_view (id, color_id, view_count, created_at) VALUES (?, ?, 1, datetime('now'))`,
        [`cv-${actualColorId}`, actualColorId],
      );
    }
    if (await this.hasTable('client_color_view')) {
      const existingClient = await this.get<{ id: string; view_count: number }>(
        `SELECT id, view_count FROM client_color_view WHERE master_color_id = ? AND created_by = ?`,
        [actualColorId, userId],
      );
      if (existingClient) {
        await this.run(
          `UPDATE client_color_view SET view_count = view_count + 1, created_at = datetime('now') WHERE id = ?`,
          [existingClient.id],
        );
      } else {
        await this.run(
          `INSERT INTO client_color_view (id, master_color_id, created_by, view_count, created_at) VALUES (?, ?, ?, 1, datetime('now'))`,
          [`ccv-${actualColorId}-${userId}`, actualColorId, userId],
        );
      }
    }
    return {};
  }

  async materialClientActive(id: string) {
    const materials = await this.all<{
      id: string;
      system_type_id: string;
      name: string | null;
      description: string | null;
      specific_gravity: number | null;
      toner_type: string | null;
      cost_amount: number | null;
      price_amount: number | null;
      price_id: string | null;
    }>(
      `SELECT m.*, mp.cost_amount, mp.price_amount, mp.id as price_id FROM material m
       LEFT JOIN material_price mp ON mp.material_id = m.id AND mp.created_by = ?
       ORDER BY m.created_at ASC`,
      [id],
    );
    return materials.map((m) => ({
      ...m,
      material_price: {
        id: m.price_id,
        cost_amount: m.cost_amount ?? 0,
        price_amount: m.price_amount ?? 0,
      },
    }));
  }

  async materialClientUpsert(id: string, dto: CreateUpdateMaterialPriceDto) {
    await this.run(
      `DELETE FROM material_price WHERE created_by = ? AND material_id = ?`,
      [id, dto.material_id],
    );
    const priceId = `mp-${id}-${dto.material_id}-${Date.now()}`;
    await this.run(
      `INSERT INTO material_price (id, material_id, cost_amount, price_amount, created_by, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [priceId, dto.material_id, dto.cost_amount, dto.price_amount, id],
    );
    return { id: priceId };
  }

  async materialClientUpdateMargin(dto: UpdateMarginDto) {
    const rows = await this.all<{ id: string; cost_amount: number }>(
      `SELECT id, cost_amount FROM material_price WHERE created_by = ? AND cost_amount IS NOT NULL`,
      [dto.id],
    );
    for (const row of rows) {
      const newPrice = row.cost_amount * (dto.margin_percent / 100 + 1);
      await this.run(
        `UPDATE material_price SET price_amount = ? WHERE id = ?`,
        [newPrice, row.id],
      );
    }
    return rows;
  }

  // ---- Filter (master colors) and client-filter: simplified paginated list ----

  async colorClientFilter(filter: ColorFilterDto & { id: string }) {
    const pageNumber = Number(filter.pageNumber ?? 1);
    const pageSize = Number(filter.pageSize ?? 20);
    let where = `c.is_active = 1 AND c.is_deleted = 0`;
    const params: unknown[] = [];
    if (filter.brand_id) {
      where += ` AND c.make_id = ?`;
      params.push(filter.brand_id);
    }
    if (filter.year !== undefined) {
      where += ` AND c.year_first <= ? AND c.year_last >= ?`;
      params.push(filter.year, filter.year);
    }
    if (filter.model_id) {
      where += ` AND EXISTS (SELECT 1 FROM color_model cm WHERE cm.color_id = c.id AND cm.model_id = ?)`;
      params.push(filter.model_id);
    }
    if (filter.color_group_id) {
      where += ` AND EXISTS (SELECT 1 FROM color_family_list cfl WHERE cfl.color_id = c.id AND cfl.color_family_id = ?)`;
      params.push(filter.color_group_id);
    }
    if (filter.region_id) {
      where += ` AND EXISTS (SELECT 1 FROM color_region cr WHERE cr.color_id = c.id AND cr.region_id = ? AND cr.is_deleted = 0)`;
      params.push(filter.region_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      where += ` AND (EXISTS (SELECT 1 FROM color_code cc WHERE cc.color_id = c.id AND cc.oem_color_code LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM color_description cd WHERE cd.color_id = c.id AND cd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    const totalRow = await this.get<{ total: number }>(
      `SELECT COUNT(DISTINCT c.id) as total FROM color c WHERE ${where}`,
      params,
    );
    const total = totalRow?.total ?? 0;
    const orderBy = filter.sort === 'latest colors' ? 'c.created_at DESC' : 'c.year_last DESC';
    const offset = (pageNumber - 1) * pageSize;
    const colorIds = await this.all<{ id: string }>(
      `SELECT c.id FROM color c WHERE ${where} ORDER BY ${orderBy}, c.id LIMIT ? OFFSET ?`,
      [...params, pageSize, offset],
    );
    const data: any[] = [];
    for (const { id: cid } of colorIds) {
      const c = await this.get<{ year_first: number; year_last: number; rgb_value: string; created_at: string }>(`SELECT year_first, year_last, rgb_value, created_at FROM color WHERE id = ?`, [cid]);
      if (!c) continue;
      const make = await this.get<{ id: string; name: string; image_path: string }>(`SELECT id, name, image_path FROM make WHERE id = (SELECT make_id FROM color WHERE id = ?)`, [cid]);
      const codes = await this.all<{ oem_color_code: string }>(`SELECT oem_color_code FROM color_code WHERE color_id = ?`, [cid]);
      const descs = await this.all<{ color_description: string }>(`SELECT color_description FROM color_description WHERE color_id = ?`, [cid]);
      const families = await this.all<{ id: string; name: string; rgb: string }>(
        `SELECT cf.id, cf.name, cf.rgb FROM color_family cf INNER JOIN color_family_list cfl ON cfl.color_family_id = cf.id WHERE cfl.color_id = ? AND cf.is_active = 1 AND cf.is_deleted = 0`,
        [cid],
      );
      const models = await this.all<{ id: string; name: string }>(
        `SELECT mod.id, mod.name FROM model mod INNER JOIN color_model cm ON cm.model_id = mod.id WHERE cm.color_id = ?`,
        [cid],
      );
      data.push({
        id: cid,
        year_first: c.year_first,
        year_last: c.year_last,
        make,
        created_at: c.created_at,
        created_by: '',
        view_count: 0,
        is_variant: false,
        material_type: ['Solid'],
        color_swatch: [],
        color_codes: [...new Set(codes.map((x) => x.oem_color_code))],
        color_descriptions: [...new Set(descs.map((x) => x.color_description))],
        color_groups: families,
        models: models.map((m) => ({ id: m.id, name: m.name })),
        colors: [
          {
            id: cid,
            rgb_value: c.rgb_value ?? (families[0]?.rgb ?? null),
            code: codes.map((x) => x.oem_color_code),
            descriptions: descs.map((x) => x.color_description),
            is_variant: false,
            material_type: ['Solid'],
          },
        ],
      });
    }
    return {
      data,
      pagination: {
        total,
        pageNumber,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  async colorClientClientFilter(filter: ColorFilterDto & { id: string }) {
    const pageNumber = Number(filter.pageNumber ?? 1);
    const pageSize = Number(filter.pageSize ?? 20);
    let where = `cc.is_active = 1 AND cc.is_deleted = 0 AND cc.created_by = ?`;
    const params: unknown[] = [filter.id];
    if (filter.brand_id) {
      where += ` AND cc.make_id = ?`;
      params.push(filter.brand_id);
    }
    if (filter.year !== undefined) {
      where += ` AND cc.year_first <= ? AND cc.year_last >= ?`;
      params.push(filter.year, filter.year);
    }
    if (filter.model_id) {
      where += ` AND EXISTS (SELECT 1 FROM client_color_model ccm WHERE ccm.color_id = cc.id AND ccm.model_name = ?)`;
      params.push(filter.model_id);
    }
    if (filter.color_group_id) {
      where += ` AND EXISTS (SELECT 1 FROM client_color_family_list ccfl WHERE ccfl.color_id = cc.id AND ccfl.color_family_id = ?)`;
      params.push(filter.color_group_id);
    }
    if (filter.search_term?.trim()) {
      const t = `%${sqlLikeEscape(filter.search_term.trim())}%`;
      where += ` AND (EXISTS (SELECT 1 FROM client_color_code ccc WHERE ccc.color_id = cc.id AND ccc.oem_color_code LIKE ? ESCAPE '\\') OR EXISTS (SELECT 1 FROM client_color_description ccd WHERE ccd.color_id = cc.id AND ccd.color_description LIKE ? ESCAPE '\\'))`;
      params.push(t, t);
    }
    const totalRow = await this.get<{ total: number }>(
      `SELECT COUNT(*) as total FROM client_color cc WHERE ${where}`,
      params,
    );
    const total = totalRow?.total ?? 0;
    const colorIds = await this.all<{ id: string }>(
      `SELECT cc.id FROM client_color cc WHERE ${where} ORDER BY cc.year_first DESC, cc.id LIMIT ? OFFSET ?`,
      [...params, pageSize, (pageNumber - 1) * pageSize],
    );
    const data: any[] = [];
    for (const { id: cid } of colorIds) {
      const c = await this.get<{ year_first: number; year_last: number; rgb_value: string }>(`SELECT year_first, year_last, rgb_value FROM client_color WHERE id = ?`, [cid]);
      if (!c) continue;
      const makeIdRow = await this.get<{ make_id: string }>(`SELECT make_id FROM client_color WHERE id = ?`, [cid]);
      const make = makeIdRow
        ? await this.get<{ id: string; name: string; image_path: string }>(`SELECT id, name, image_path FROM make WHERE id = ?`, [makeIdRow.make_id])
        : null;
      const codes = await this.all<{ oem_color_code: string }>(`SELECT oem_color_code FROM client_color_code WHERE color_id = ?`, [cid]);
      const descs = await this.all<{ color_description: string }>(`SELECT color_description FROM client_color_description WHERE color_id = ?`, [cid]);
      const families = await this.all<{ id: string; name: string; rgb: string }>(
        `SELECT cf.id, cf.name, cf.rgb FROM color_family cf INNER JOIN client_color_family_list ccfl ON ccfl.color_family_id = cf.id WHERE ccfl.color_id = ? AND cf.is_active = 1 AND cf.is_deleted = 0`,
        [cid],
      );
      const modelIds = await this.all<{ id: string }>(`SELECT id FROM client_color_model WHERE color_id = ?`, [cid]);
      data.push({
        id: cid,
        year_first: c.year_first,
        year_last: c.year_last,
        make: make ?? undefined,
        color_codes: [...new Set(codes.map((x) => x.oem_color_code))],
        color_descriptions: [...new Set(descs.map((x) => x.color_description))],
        color_groups: families,
        models: modelIds.map((m) => ({ id: m.id })),
        colors: [
          {
            id: cid,
            rgb_value: c.rgb_value ?? (families[0]?.rgb ?? null),
            code: codes.map((x) => x.oem_color_code),
            descriptions: descs.map((x) => x.color_description),
          },
        ],
      });
    }
    return {
      data,
      pagination: {
        total,
        pageNumber,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  async colorClientGroup(color_id: string) {
    const combos = await this.all<{ color_id: string }>(
      `SELECT color_id FROM color_combination WHERE group_color_id = ?`,
      [color_id],
    );
    const results: any[] = [];
    for (const { color_id: cid } of combos) {
      const c = await this.get<{ id: string; year_first: number; year_last: number; rgb_value: string }>(`SELECT id, year_first, year_last, rgb_value FROM color WHERE id = ? AND is_active = 1 AND is_deleted = 0`, [cid]);
      if (!c) continue;
      const make = await this.get<{ id: string; name: string; image_path: string }>(`SELECT id, name, image_path FROM make WHERE id = (SELECT make_id FROM color WHERE id = ?)`, [cid]);
      const codes = await this.all<{ oem_color_code: string }>(`SELECT oem_color_code FROM color_code WHERE color_id = ?`, [cid]);
      const descs = await this.all<{ color_description: string }>(`SELECT color_description FROM color_description WHERE color_id = ?`, [cid]);
      const families = await this.all<{ id: string; name: string; rgb: string }>(
        `SELECT cf.id, cf.name, cf.rgb FROM color_family cf INNER JOIN color_family_list cfl ON cfl.color_family_id = cf.id WHERE cfl.color_id = ? AND cf.is_active = 1 AND cf.is_deleted = 0`,
        [cid],
      );
      const models = await this.all<{ id: string; name: string }>(
        `SELECT mod.id, mod.name FROM model mod INNER JOIN color_model cm ON cm.model_id = mod.id WHERE cm.color_id = ?`,
        [cid],
      );
      const hasVariant = await this.get<{ n: number }>(`SELECT 1 as n FROM color_variant WHERE color_id = ? LIMIT 1`, [cid]);
      results.push({
        id: c.id,
        year_first: c.year_first,
        year_last: c.year_last,
        make,
        is_variant: !!hasVariant,
        material_type: ['Solid'],
        color_codes: [...new Set(codes.map((x) => x.oem_color_code))],
        color_descriptions: [...new Set(descs.map((x) => x.color_description))],
        color_groups: families,
        models: models.map((m) => ({ id: m.id, name: m.name })),
        colors: [
          {
            id: c.id,
            rgb_value: c.rgb_value ?? (families[0]?.rgb ?? null),
            code: codes.map((x) => x.oem_color_code),
            descriptions: descs.map((x) => x.color_description),
            is_variant: !!hasVariant,
          },
        ],
      });
    }
    if (!results.length) throw new Error('Color group not found');
    return results;
  }

  async colorClientVariant(color_id: string) {
    const baseRows = await this.all<{ reference_id: string; is_variant: number; color_code: string | null }>(
      `SELECT reference_id, is_variant, color_code FROM color_variant_list WHERE reference_id = ? AND is_variant = 0`,
      [color_id],
    );
    const swatch = await this.all<{ swatch_number: string | null; chromatic_code: string | null }>(
      `SELECT swatch_number, chromatic_code FROM color_swatch WHERE color_id = ?`,
      [color_id],
    );
    const baseResult = baseRows.map((r) => ({
      reference_id: r.reference_id,
      is_variant: false,
      color_code: r.color_code,
      vt: '',
      color_swatch: swatch,
    }));
    const variantIds = await this.all<{ id: string }>(`SELECT id FROM color_variant WHERE color_id = ?`, [color_id]);
    const variantResult: { reference_id: string; is_variant: boolean; color_code: string | null; vt: string; color_swatch: unknown }[] = [];
    for (const v of variantIds) {
      const listRows = await this.all<{ reference_id: string; color_code: string | null }>(
        `SELECT reference_id, color_code FROM color_variant_list WHERE reference_id = ? AND is_variant = 1`,
        [v.id],
      );
      const vtName = await this.get<{ name: string }>(
        `SELECT vt.name FROM variant_type vt INNER JOIN color_variant cv ON cv.variant_type_id = vt.id WHERE cv.id = ?`,
        [v.id],
      );
      const vSwatch = await this.all<{ swatch_number: string | null; chromatic_code: string | null }>(
        `SELECT swatch_number, chromatic_code FROM color_swatch WHERE color_variant_id = ?`,
        [v.id],
      );
      for (const r of listRows) {
        variantResult.push({
          reference_id: r.reference_id,
          is_variant: true,
          color_code: r.color_code,
          vt: vtName?.name ?? '',
          color_swatch: vSwatch,
        });
      }
    }
    return [...baseResult, ...variantResult].sort((a, b) => {
      if (a.is_variant !== b.is_variant) return Number(a.is_variant) - Number(b.is_variant);
      return (a.color_code ?? '').localeCompare(b.color_code ?? '');
    });
  }
}
