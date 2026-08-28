# Changelog

本项目的所有重要变更都会记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-08-28

### Added

- 输入框工具行「人设」小框，点击展开管理面板
- 人设模板的新建 / 编辑 / 删除 / 切换
- 最高优先级系统提示注入（order -1000，位于 DSH 身份声明之前）
- 固定交互条款：提问必须走 `ask_user_question` 可点选卡片
- 按 `sessionId` 隔离的会话级人设
- 子代理沿 parentSession 谱系继承人设
- 新对话继承最近一次使用的人设
- 删除保护：使用中的模板禁止删除
- 状态持久化于 `%DSH_HOME%\dsh-plugin-masterprompt\state.json`，重启保留
- 损坏状态文件自动备份为 `state.json.corrupt-<时间戳>` 并重建
