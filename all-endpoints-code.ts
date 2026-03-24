/**
 * DTO types for client API endpoints.
 * Used by AllEndpointsCodeSqlite (local SQLite) and by the data source layer.
 * Same shapes as the backend DTOs so API and SQLite can share call sites.
 */

export interface BrandFilterDto {
  color_group_id?: string;
  region_id?: string;
  search_term?: string;
}

export interface ModelFilterDto {
  brand_id: string;
  color_group_id?: string;
  region_id?: string;
  search_term?: string;
}

export interface YearFilterDto {
  brand_id: string;
  model_id: string;
  color_group_id?: string;
  region_id?: string;
  search_term?: string;
}

export interface ColorGroupFilterDto {
  brand_id?: string;
  model_id?: string;
  year?: number;
  search_term?: string;
}

export interface ColorFilterDto {
  brand_id?: string;
  model_id?: string;
  year?: number;
  region_id?: string;
  search_term?: string;
  sort?: string;
  color_group_id?: string;
  pageNumber?: number;
  pageSize?: number;
}

export interface CreateClientColorDto {
  year_first?: number;
  year_last?: number;
  rgb_value?: string;
  make_id: string;
  created_by: string;
  updated_by: string;
  families?: { color_family_id: string }[];
  layers?: {
    color_version?: string;
    system_type_id?: string | null;
    layer_number?: number;
    materials?: { material_id: string; quantity: number }[];
  }[];
  codes?: { oem_color_code: string }[];
  descriptions?: { color_description: string }[];
  models?: { model_name: string }[];
}

export interface UpdateClientColorDto {
  year_first?: number;
  year_last?: number;
  rgb_value?: string;
  make_id?: string;
  updated_by?: string;
  families?: { color_family_id: string }[];
  layers?: {
    color_version?: string;
    system_type_id?: string | null;
    layer_number?: number;
    materials?: { material_id: string; quantity: number }[];
  }[];
  codes?: { oem_color_code: string }[];
  descriptions?: { color_description: string }[];
}

export interface CreateUpdateMaterialPriceDto {
  material_id: string;
  cost_amount: number;
  price_amount: number;
}

export interface UpdateMarginDto {
  id: string;
  margin_percent: number;
}
