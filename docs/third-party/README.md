# 依赖许可补充来源

这里仅补充锁定依赖的发布包缺少单独 LICENSE 文件、但已能从实际版本验证的许可文本，不修改依赖代码，也不为未知许可自动补写文本。

- `@ai-sdk/provider-utils@5.0.66` 的 npm 包声明 Apache-2.0 但不携带 LICENSE；官方同名 tag 指向 `401cadc4e6743ebc000ef5bbb54d84f6a201b1db`，保存该提交仓库根 LICENSE 原文。
- `@tokenizer/token@0.3.0` 的完整 MIT 文本位于其 npm 包 README 的 Licence 节，含 `Copyright (c) 2020 Borewit`；官方 v0.3.0 tag 解引用为 `e068a455370090f44c757946b8571bb3fb1f117e`，该仓库版本也将许可放在 README。保存这段许可原文。
- 真实 hoisted 生产树额外包含 `@koromix/koffi-win32-x64@3.3.6`，其包声明 MIT、作者与仓库同 Koffi，但未附 LICENSE。作者的 [官方贡献指南](https://koffi.dev/contribute) 明确源码位于 Codeberg monorepo，发布 tag 格式为 `koffi/X.Y.Z`；实际 `koffi/3.3.6` tag 解引用为 `1a894d9e1d5041c25d4cd31c93a345a5a77cb1a2`。该提交 `src/koffi/LICENSE.txt` 的 SHA-256 与本地 `koffi@3.3.6` 发布包 LICENSE.txt 完全一致，保存此精确版本原文供该原生可选包声明绑定使用。

`supplements.json` 绑定精确版本、许可声明、不可变提交来源及文本 SHA-256；变更依赖版本必须重新核实，不能按供应商名字套用旧文本。发布工具校验散列并把来源写进可移植清单。这是工程许可证材料收集，不等于对第三方全部权利或商标作法律保证。
