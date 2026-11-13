## examples/ssr (reflection region; W70 -> W76)

| scene | drift | rest flicker | drift AA off | drift upscale 1.5 | orbit std | orbit d2 | quad display / raw | pan d2 border | speckle % | energy loss |
|---|---|---|---|---|---|---|---|---|---|---|
| mirrorWall | 0.307 -> 0.308 | 0.009 -> 0.009 | 0.034 -> 0.034 | 0.388 -> 0.388 | 0.462 -> 0.467 | 0.749 -> 0.747 | 0.023 / 0.345 -> 0.024 / 0.165 | 7.67 -> 7.68 | 0.015 -> 0.016 | 0.005 -> 0.005 |
| contact | 0.732 -> 0.785 | 4.503 -> 4.503 | 0.210 -> 0.191 | 1.013 -> 0.883 (down) | 9.711 -> 9.437 (down) | 12.237 -> 11.654 | 0.017 / 0.614 -> 0.016 / 0.684 | 21.25 -> 16.28 (down) | 0.016 -> 0.017 | 0.023 -> 0.019 |

## showcase (bench, ours denoised; W70 -> W76)

| scene | glossy MAD dn / raw (+ RT) | drift | rest flicker | orbit std | orbit d2 | quad dn | speckle % (signal) | energy loss |
|---|---|---|---|---|---|---|---|---|
| carConcept | 13.75 / 12.99 -> 13.60 / 12.84 (RT 8.66) | 0.265 -> 0.272 | 0.007 -> 0.007 | 0.391 -> 0.393 | 0.33 -> 0.33 | 0.047 -> 0.048 | 0.054 -> 0.057 | 0.030 -> 0.042 |
|  regions | lip 114.1 -> 114.1 (RT 52.8); band 161.1 -> 161.1 (RT 24.9); wheel 56.6 -> 56.5 (RT 31.1); door 13.8 -> 13.8 (RT 11.3); car 31.5 -> 31.3 (RT 14.9) | | | | | | | |
