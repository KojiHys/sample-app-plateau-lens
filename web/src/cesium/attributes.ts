export const ATTRIBUTES = {
  address: "bldg:address",
  buildingClass: "bldg:class",
  buildingCoverageRate:
    "uro:BuildingDetailAttribute_uro:specifiedBuildingCoverageRate",
  buildingId: "uro:BuildingIDAttribute_uro:buildingID",
  districtsAndZones: "uro:BuildingDetailAttribute_uro:districtsAndZonesType",
  fireproofStructure:
    "uro:BuildingDetailAttribute_uro:fireproofStructureType",
  floodDepth:
    "荒川水系神田川流域（都道府県管理区間）_L2（想定最大規模）_浸水深",
  floorAreaRate: "uro:BuildingDetailAttribute_uro:specifiedFloorAreaRate",
  height: "bldg:measuredHeight",
  landslideRisk: "土砂災害リスク_急傾斜地の崩落_区域区分コード",
  lod: "_lod",
  roofArea: "uro:BuildingDetailAttribute_uro:buildingRoofEdgeArea",
  storeysAboveGround: "bldg:storeysAboveGround",
  storeysBelowGround: "bldg:storeysBelowGround",
  stormSurgeFloodDepth:
    "高潮浸水想定_東京都高潮浸水想定区域図（令和6年12月19日）_浸水深",
  sumidaFloodDepth:
    "隅田川・新河岸川流域（都道府県管理区間）_L2（想定最大規模）_浸水深",
  usage: "bldg:usage",
} as const;

export const TILESET_RANGES = {
  floodDepth: { min: 0.1, max: 3.42, step: 0.01, unit: "m" },
  height: { min: 0.8, max: 209.5, step: 0.1, unit: "m" },
  roofArea: { min: 1.54, max: 22_322.6, step: 0.01, unit: "m²" },
  storeysAboveGround: { min: 1, max: 44, step: 1, unit: "階" },
} as const;

export const NUMERIC_FILTER_KEYS = [
  "height",
  "storeysAboveGround",
  "roofArea",
  "floodDepth",
] as const;

export type NumericFilterKey = (typeof NUMERIC_FILTER_KEYS)[number];

export const NUMERIC_FILTERS = {
  floodDepth: {
    attribute: ATTRIBUTES.floodDepth,
    label: "浸水深（神田川 L2）",
    ...TILESET_RANGES.floodDepth,
  },
  height: {
    attribute: ATTRIBUTES.height,
    label: "高さ",
    ...TILESET_RANGES.height,
  },
  roofArea: {
    attribute: ATTRIBUTES.roofArea,
    label: "屋根投影面積",
    ...TILESET_RANGES.roofArea,
  },
  storeysAboveGround: {
    attribute: ATTRIBUTES.storeysAboveGround,
    label: "地上階数",
    ...TILESET_RANGES.storeysAboveGround,
  },
} as const satisfies Record<
  NumericFilterKey,
  {
    attribute: string;
    label: string;
    max: number;
    min: number;
    step: number;
    unit: string;
  }
>;

export const CATEGORY_FILTER_KEYS = ["usage", "districtsAndZones"] as const;
export type CategoryFilterKey = (typeof CATEGORY_FILTER_KEYS)[number];

export const CATEGORY_FILTERS = {
  districtsAndZones: {
    attribute: ATTRIBUTES.districtsAndZones,
    label: "用途地域",
  },
  usage: {
    attribute: ATTRIBUTES.usage,
    label: "建物用途",
  },
} as const satisfies Record<
  CategoryFilterKey,
  { attribute: string; label: string }
>;

export const ATTRIBUTE_PANEL_FIELDS = [
  { attribute: ATTRIBUTES.buildingClass, label: "建物区分" },
  { attribute: ATTRIBUTES.address, label: "住所" },
  { attribute: ATTRIBUTES.storeysBelowGround, label: "地下階数", unit: "階" },
  { attribute: ATTRIBUTES.buildingId, label: "建物ID" },
  {
    attribute: ATTRIBUTES.buildingCoverageRate,
    label: "指定建ぺい率",
    unit: "%",
  },
  {
    attribute: ATTRIBUTES.floorAreaRate,
    label: "指定容積率",
    unit: "%",
  },
  { attribute: ATTRIBUTES.fireproofStructure, label: "耐火構造種別" },
  {
    attribute: ATTRIBUTES.sumidaFloodDepth,
    label: "浸水深（隅田川・新河岸川 L2）",
    unit: "m",
  },
  {
    attribute: ATTRIBUTES.stormSurgeFloodDepth,
    label: "高潮浸水深",
    unit: "m",
  },
  {
    attribute: ATTRIBUTES.landslideRisk,
    label: "急傾斜地崩落区域区分コード",
  },
] as const;

export type AttributeName = (typeof ATTRIBUTES)[keyof typeof ATTRIBUTES];
