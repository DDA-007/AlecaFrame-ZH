# AlecaFrame-ZH 使用说明

适用系统：Windows 10 / 11 64 位。本次适配 AlecaFrame **3.0.4** 的新版导航、仓库、交易面板、遗物规划和仲裁窗口，补充仲裁星球及裂罅词条的中文显示，并在 Overwolf **0.311.1.1** 上验证了启动及数据初始化。启动器按实际窗口清单加载汉化，不限制固定版本号；后续更新的兼容性仍以实际运行结果为准。

物品词库已按 2026 年 9 月 30 日官方数据更新，包含石晶之花 Prime、闪劫 Prime、寒怨刺、霜冥差及对应部件。战甲名称保留英文。

## 安装与启动

1. 先正常安装官方 Overwolf 和 AlecaFrame，并打开一次官方 AlecaFrame。
2. 将本压缩包完整解压到固定文件夹，双击 `Install.cmd` 创建桌面快捷方式。
3. 从系统托盘完全退出 Overwolf，再双击桌面 `AlecaFrame-ZH`。也可运行文件夹中的 `Start-Chinese.cmd`。
4. 等待中文界面加载，使用期间保留启动器窗口。使用完从托盘完全退出 Overwolf，启动器会恢复官方文件并退出。

移动文件夹后，请在新位置重新运行 `Install.cmd`。

## 可选 OCR

OCR 默认关闭，使用中文界面无需安装 OCR 依赖。

- 需要 OCR：先运行 `安装OCR前置组件.cmd`，完成后运行 `启用中文遗物OCR.cmd`。
- 关闭 OCR：运行 `关闭中文遗物OCR.cmd`。
- 开关在完全退出 Overwolf、重新通过中文入口启动后生效。

压缩包不附带依赖和模型。前置安装器会联网下载到本文件夹的 `.tools` 中，已完整安装的组件会跳过。OCR 识别需要读取游戏画面，游戏内效果仍需实际验证。

## 恢复英文与常见问题

- 恢复英文：运行 `Uninstall.cmd`，它会关闭 Overwolf、恢复官方文件并移除中文快捷方式。
- 提示 Overwolf 正在运行：先从托盘完全退出后再启动。
- 官方更新后：无需手动注释版本检查，可直接通过中文入口启动。如果提示页面结构不匹配、初始化超时或应用被关闭，则需要针对实际错误更新补丁；启动失败会尝试恢复官方文件。
- OCR 安装失败：检查网络和磁盘空间，再运行一次前置安装器。

当前适配会让本次 Overwolf 会话中所有扩展的完整性错误仅记录、不关闭应用。请使用上述中文入口，并等待退出时的恢复流程完成。

## 来源与授权

本项目基于 [MIOEU/AlecaFrame-ZH](https://github.com/MIOEU/AlecaFrame-ZH) 修改，原作者为想吃西瓜。由 DDA-007 维护当前适配版本，新增启动兼容适配、中文 OCR 支持及物品词库更新。

部分物品译名参考 Roc 维护的 [Warframe-Chinese-English-Bilingual](https://github.com/AdminRoc/Warframe-Chinese-English-Bilingual)，其 README 声明采用 MIT 协议；最新物品译名根据 Warframe 官方 PublicExport 中英文数据核对。

本项目按随附的 [MIT License](LICENSE) 授权，保留原作者版权声明；DDA-007 的署名仅针对修改部分。
