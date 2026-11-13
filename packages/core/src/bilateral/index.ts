// Joint bilateral gather of a sparse reflection signal (W74, X4's fill; X5's upsample).
export {
  BILATERAL_FILL_WGSL, BILATERAL_SOURCE_CODES, DEFAULT_BILATERAL_FILL_WEIGHTS, bilateralFillWeightWords, resolveBilateralFillWeights,
  type BilateralFillWeights,
} from './fill';
