# Changelog

## [0.2.0](https://github.com/sean-reid/cloud-atlas/compare/cloud-atlas-v0.1.0...cloud-atlas-v0.2.0) (2026-10-10)


### Features

* availability history ribbon and hourly readings per region ([#13](https://github.com/sean-reid/cloud-atlas/issues/13)) ([c66f8fa](https://github.com/sean-reid/cloud-atlas/commit/c66f8fa366410d13c6a92bb194cf91db8babe1e8))
* AWS placement score and capacity block probes ([#10](https://github.com/sean-reid/cloud-atlas/issues/10)) ([e99c1b4](https://github.com/sean-reid/cloud-atlas/commit/e99c1b49b9d40c62ec50cbd21b6c55f2769df1cd))
* date a region from its first appearance in the provider's documentation ([#15](https://github.com/sean-reid/cloud-atlas/issues/15)) ([50934d7](https://github.com/sean-reid/cloud-atlas/commit/50934d7e2a4d28dd522c822b30c3a87ec076fc8d))
* dated region launches for Google Cloud and Azure from provider announcements ([#8](https://github.com/sean-reid/cloud-atlas/issues/8)) ([71ce3d4](https://github.com/sean-reid/cloud-atlas/commit/71ce3d49201ce188f88944bcd6fca003e2d30e61))
* evidence store, ingest pipeline, read-only API, and the atlas site ([#5](https://github.com/sean-reid/cloud-atlas/issues/5)) ([bec943e](https://github.com/sean-reid/cloud-atlas/commit/bec943e8d9074f2ca9a76da848bddc8700c3a136))
* Google Cloud calendar-mode lead time probe ([#11](https://github.com/sean-reid/cloud-atlas/issues/11)) ([028e885](https://github.com/sean-reid/cloud-atlas/commit/028e885a16cf23d8c7f95da083d9fc245edd407d))
* hourly news-feeds adapter with review accept and fixtures ([#28](https://github.com/sean-reid/cloud-atlas/issues/28)) ([740aa57](https://github.com/sean-reid/cloud-atlas/commit/740aa57f08870daed95517bbe779de30f8541268))
* keep pending observations and the review queue off the public pages ([#14](https://github.com/sean-reid/cloud-atlas/issues/14)) ([6e417f0](https://github.com/sean-reid/cloud-atlas/commit/6e417f029940387fa6bd5d075ae8aad86d4550ce))
* Oracle, Alibaba, and Tencent sold-out probes ([#12](https://github.com/sean-reid/cloud-atlas/issues/12)) ([67fd685](https://github.com/sean-reid/cloud-atlas/commit/67fd685c30bf5cd9b2328ad109475186b4e25628))
* **pipeline:** collapse hourly signals older than 90 days ([#22](https://github.com/sean-reid/cloud-atlas/issues/22)) ([31761f6](https://github.com/sean-reid/cloud-atlas/commit/31761f6e84c67ce22d3582fd76bf95ba1815ae40))
* **pipeline:** place Alibaba and Oracle regions from the probes ([#18](https://github.com/sean-reid/cloud-atlas/issues/18)) ([d8868a8](https://github.com/sean-reid/cloud-atlas/commit/d8868a82f67bdb0d4f5a42ee9c8484a72d702eb0))
* rate limit the API per client and cache responses at the edge ([#7](https://github.com/sean-reid/cloud-atlas/issues/7)) ([bb0825a](https://github.com/sean-reid/cloud-atlas/commit/bb0825af210fdde16610eacb68961c3ac1f1e38f))
* shared availability rules, adapter metadata, and credential plumbing for account probes ([#6](https://github.com/sean-reid/cloud-atlas/issues/6)) ([45fd180](https://github.com/sean-reid/cloud-atlas/commit/45fd180dba8830ca456512b384fd7a28f3681079))
* shell worker, app skeleton, and initial schema ([85f080e](https://github.com/sean-reid/cloud-atlas/commit/85f080e6abcfedd6cf1c6b8f8bea0b2f6f80e38c))
* **web:** hide the hourly plot and cap the history ribbon ([#17](https://github.com/sean-reid/cloud-atlas/issues/17)) ([3dd8885](https://github.com/sean-reid/cloud-atlas/commit/3dd88857c47b260be16987270d7e537f3125c309))
* **web:** redesign the availability history window and plots ([#16](https://github.com/sean-reid/cloud-atlas/issues/16)) ([7b68b6a](https://github.com/sean-reid/cloud-atlas/commit/7b68b6acb00e6cc0fb14291e6f6c8174e6a622e6))


### Bug Fixes

* **ci:** apply D1 migrations before every ingest ([#29](https://github.com/sean-reid/cloud-atlas/issues/29)) ([59df4c8](https://github.com/sean-reid/cloud-atlas/commit/59df4c80faca7bb314f20ee3f754f06a066df812))
* **ci:** run every hourly adapter on the hourly cron ([#23](https://github.com/sean-reid/cloud-atlas/issues/23)) ([d25857e](https://github.com/sean-reid/cloud-atlas/commit/d25857e6720d6f3b57f837e6d83d9c085b838d5c))
* **cli:** open the right local database and fail on unknown adapters ([#30](https://github.com/sean-reid/cloud-atlas/issues/30)) ([c206c79](https://github.com/sean-reid/cloud-atlas/commit/c206c79ebdc2d4a5d3697c46932b5313c34c283e))
* correct selection, filtering, history and source counts from the audit ([#44](https://github.com/sean-reid/cloud-atlas/issues/44)) ([e74d4ee](https://github.com/sean-reid/cloud-atlas/commit/e74d4ee3888c9d4d193786572223f4d569acf325))
* harden the worker and pipeline against the audit findings ([#43](https://github.com/sean-reid/cloud-atlas/issues/43)) ([201e40b](https://github.com/sean-reid/cloud-atlas/commit/201e40b0b27be46c2ef4ed3c55a1f6c91bef002a))
* **pipeline:** fall back to recorded GPU zones when the docs table is missing ([#20](https://github.com/sean-reid/cloud-atlas/issues/20)) ([1f933c0](https://github.com/sean-reid/cloud-atlas/commit/1f933c0790d216175a8673ee5049c4db8aaea526))
* **pipeline:** never date a provider's first region seeding ([#27](https://github.com/sean-reid/cloud-atlas/issues/27)) ([d690160](https://github.com/sean-reid/cloud-atlas/commit/d6901609023a163bf0ef2f7051cad9806481b15e))
* **pipeline:** require an earlier run before dating a first-seen region ([#31](https://github.com/sean-reid/cloud-atlas/issues/31)) ([92c9ca2](https://github.com/sean-reid/cloud-atlas/commit/92c9ca2268823e00a85e57af79a95b8bd5718d5d))
* **pipeline:** stop the calendar-mode probe when the project is not admitted ([#25](https://github.com/sean-reid/cloud-atlas/issues/25)) ([11776a0](https://github.com/sean-reid/cloud-atlas/commit/11776a0f5daf35ecc83d014093352a193ea3fcf5))
* **web:** fix the UX and accessibility findings from the audit ([#45](https://github.com/sean-reid/cloud-atlas/issues/45)) ([841dd13](https://github.com/sean-reid/cloud-atlas/commit/841dd1356232769e3565d8b681db6154b9f67729))
* **web:** keep the availability grid readable at tablet width ([#19](https://github.com/sean-reid/cloud-atlas/issues/19)) ([b514660](https://github.com/sean-reid/cloud-atlas/commit/b514660fff69d59eebfcc83a6131f46ed81c1606))
* **web:** list uncovered probes from live signals, without variable names ([#21](https://github.com/sean-reid/cloud-atlas/issues/21)) ([fc2a223](https://github.com/sean-reid/cloud-atlas/commit/fc2a2237d9dd9b07d565c78f051879d82be5d2e8))
* **web:** order availability providers and fit the chart gutter to its labels ([#26](https://github.com/sean-reid/cloud-atlas/issues/26)) ([7dab58c](https://github.com/sean-reid/cloud-atlas/commit/7dab58cd7a38002ce62b173ae418f867ab3bf1d6))
* **worker:** show the worst zone when a region has several verdicts ([#24](https://github.com/sean-reid/cloud-atlas/issues/24)) ([0af896d](https://github.com/sean-reid/cloud-atlas/commit/0af896df59cdb64db3b0bc73fa3a277b54e4d031))
