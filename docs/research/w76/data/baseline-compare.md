## examples/ssr (reflection region; W70 -> W76)

| scene | drift | rest flicker | drift AA off | drift upscale 1.5 | orbit std | orbit d2 | quad display / raw | pan d2 border | speckle % | energy loss |
|---|---|---|---|---|---|---|---|---|---|---|
| mirrorWall | 0.307 -> 0.309 | 0.009 -> 0.009 | 0.034 -> 0.034 | 0.388 -> 0.387 | 0.462 -> 0.470 | 0.749 -> 0.748 | 0.023 / 0.345 -> 0.019 / 0.137 | 7.67 -> 7.68 | 0.015 -> 0.017 | 0.005 -> 0.004 |
| contact | 0.732 -> 0.776 | 4.503 -> 4.507 | 0.210 -> 0.189 | 1.013 -> 0.961 | 9.711 -> 9.828 | 12.237 -> 12.151 | 0.017 / 0.614 -> 0.022 / 0.681 | 21.25 -> 19.27 (down) | 0.016 -> 0.019 | 0.023 -> 0.020 |
| facingMirrors | 0.404 -> 0.406 | 0.012 -> 0.012 | 0.035 -> 0.034 | 0.503 -> 0.508 | 0.611 -> 0.607 | 1.225 -> 1.227 | 0.061 / 0.250 -> 0.065 / 0.212 | 11.47 -> 11.75 | 0.032 -> 0.040 | 0.012 -> 0.009 |
| moving | 0.403 -> 0.400 | 0.010 -> 0.010 | 0.081 -> 0.069 | 0.488 -> 0.496 | 0.578 -> 0.569 | 0.962 -> 0.958 | 0.053 / 0.503 -> 0.060 / 0.492 | 8.62 -> 8.63 | 0.043 -> 0.043 | 0.022 -> 0.019 |
| offscreen | 0.306 -> 0.299 | 1.594 -> 1.600 | 0.039 -> 0.042 | 0.351 -> 0.348 | 3.173 -> 3.174 | 5.210 -> 5.210 | -0.013 / 0.424 -> -0.013 / 0.415 | 11.03 -> 11.03 | 0.004 -> 0.004 | 0.028 -> 0.028 |
| rooms | 0.123 -> 0.116 | 0.002 -> 0.002 | 0.096 -> 0.381 **UP** | 0.255 -> 0.155 (down) | 0.344 -> 0.344 | 0.287 -> 0.286 | 0.081 / 0.751 -> 0.038 / 0.509 | 1.62 -> 1.61 | 0.034 -> 0.027 | 0.028 -> 0.018 |

## showcase (bench, ours denoised; W70 -> W76)

| scene | glossy MAD dn / raw (+ RT) | drift | rest flicker | orbit std | orbit d2 | quad dn | speckle % (signal) | energy loss |
|---|---|---|---|---|---|---|---|---|
| carConcept | 13.75 / 12.99 -> 13.61 / 12.84 (RT 8.66) | 0.265 -> 0.271 | 0.007 -> 0.007 | 0.391 -> 0.394 | 0.33 -> 0.33 | 0.047 -> 0.048 | 0.054 -> 0.057 | 0.030 -> 0.042 |
|  regions | lip 114.1 -> 114.1 (RT 52.8); band 161.1 -> 161.1 (RT 24.9); wheel 56.6 -> 56.7 (RT 31.1); door 13.8 -> 13.8 (RT 11.3); car 31.5 -> 31.4 (RT 14.9) | | | | | | | |
| toyCar | 11.56 / 11.20 -> 11.56 / 11.20 (RT 11.56) | 0.119 -> 0.120 | 0.004 -> 0.004 | 0.215 -> 0.213 | 0.32 -> 0.32 | 0.061 -> 0.061 | 0.010 -> 0.009 | 0.016 -> 0.016 |
| chess | 9.89 / 9.67 -> 9.82 / 9.62 (RT 9.70) | 0.127 -> 0.130 | 0.003 -> 0.003 | 0.222 -> 0.221 | 0.32 -> 0.31 | 0.070 -> 0.070 | 0.034 -> 0.036 | 0.021 -> 0.021 |
| sponza | 43.09 / 28.48 -> 43.00 / 28.50 (RT 28.09) | 0.315 -> 0.300 | 0.011 -> 0.011 | 0.561 -> 0.555 | 5.32 -> 5.32 | -0.005 -> -0.005 | 0.332 -> 0.353 | -0.004 -> -0.010 |

## lineSpread (width ratio vs PT, peak; W70 -> W76)

- r 0.05: denoised x1.2827 (peak 0.46) -> x1.2294 (peak 0.5038); raw x0.6423 (peak 1.131) -> x0.6308 (peak 1.0951); rt x1.2411 (peak 0.4548) -> x1.169 (peak 0.5008)
- r 0.15: denoised xNone (peak 0.0228) -> x0.9814 (peak 0.136); raw xNone (peak 0.0011) -> x0.747 (peak 0.156); rt xNone (peak 0.0189) -> x0.9804 (peak 0.1368)
- r 0.3: denoised xNone (peak 0) -> xNone (peak 0); raw xNone (peak 0.0005) -> xNone (peak 0); rt xNone (peak 0) -> xNone (peak 0)
- r 0.5: denoised xNone (peak 0) -> xNone (peak 0); raw xNone (peak 0) -> xNone (peak 0); rt xNone (peak 0) -> xNone (peak 0)

## lineSpreadAAOff (width ratio vs PT, peak; W70 -> W76)

- r 0.05: denoised x1.2329 (peak 0.619) -> x1.1872 (peak 0.6767); raw x1.1142 (peak 0.8106) -> x1.1078 (peak 0.9433); rt x1.2338 (peak 0.6186) -> x1.1914 (peak 0.6883)
- r 0.15: denoised xNone (peak 0.065) -> x0.9488 (peak 0.136); raw x1.4975 (peak 0.3653) -> x1.0196 (peak 0.1632); rt xNone (peak 0.0634) -> x0.951 (peak 0.1408)
- r 0.3: denoised xNone (peak 0.0003) -> xNone (peak 0); raw x1.1361 (peak 0.7334) -> xNone (peak 0.0137); rt xNone (peak 0.0003) -> xNone (peak 0)
- r 0.5: denoised xNone (peak 0) -> xNone (peak 0); raw xNone (peak 0) -> xNone (peak 0); rt xNone (peak 0) -> xNone (peak 0)

## lineSpreadThin (width ratio vs PT, peak; W70 -> W76)

- r 0.05: denoised x4.2361 (peak 1.2311) -> x4.2214 (peak 1.2118); raw x4.0398 (peak 1.2596) -> x4.0024 (peak 1.2599); rt x1.3429 (peak 0.7317) -> x1.2647 (peak 0.7434)
- r 0.15: denoised x2.3962 (peak 7.7728) -> x2.0193 (peak 0.4495); raw x2.128 (peak 8.7008) -> x1.9813 (peak 0.5941); rt x0.695 (peak 0.945) -> xNone (peak 0.0647)
- r 0.3: denoised x1.4528 (peak 70.2656) -> xNone (peak 0.0608); raw x1.1692 (peak 82.806) -> xNone (peak 0.0233); rt x0.5006 (peak 0.4689) -> xNone (peak 0)

## grazing (MAD / gradient ratio; W70 -> W76)

- 5 deg: denoised 7.9037 / x0.8136 -> 6.9451 / x0.5447; raw 33.2342 / x87.0369 -> 7.5036 / x2.0207; rt 12.6077 / x0.942 -> 9.9442 / x0.5772
- 15 deg: denoised 9.9945 / x0.7776 -> 8.8858 / x0.5389; raw 26.1057 / x28.0425 -> 10.0109 / x3.0378; rt 20.0983 / x0.8171 -> 18.0755 / x0.5642
- 30 deg: denoised 10.5416 / x0.8103 -> 10.0787 / x0.6912; raw 17.8806 / x11.8601 -> 11.4935 / x3.5235; rt 24.8945 / x0.824 -> 24.2708 / x0.7086
- 60 deg: denoised 13.9495 / x0.5209 -> 13.9875 / x0.5185; raw 14.9003 / x4.1176 -> 14.3854 / x2.3554; rt 19.586 / x0.591 -> 19.6635 / x0.5906

Note (W76): rooms "drift AA off" 0.381 is a load-time artefact, not the defaults: re-run on fresh pages after the cone was up (scripts/drift.js, two runs each), rooms ?aa=off drift new 0.082 / 0.079, pre-W76 ('off') 0.098 / 0.100, cone alone 0.091 / 0.090, compensation 0.3 0.087 / 0.087; rest flicker new 0.028 vs old 0.038. The baseline measured right after the page load on a loaded machine, and the cone's pipelines (built asynchronously) came up between drift frames 120 and 240.
