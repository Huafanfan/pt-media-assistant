# 文档导航

整理日期：2026-09-19。先按用途选择文档；历史记录中的配置、状态和命令不应直接当作当前部署依据。

## 现行说明

| 文档 | 用途 |
| --- | --- |
| [项目 README](../README.md) | 当前功能、快速开始、部署入口和 API 概览 |
| [架构说明](ARCHITECTURE.md) | 系统职责、数据流与安全边界 |
| [AI 运行说明](operations/AI_OPERATIONS.md) | AI 配置、运行和降级说明；含历史演进章节，实际环境需核对 |

## 待审阅功能

| 功能 | 需求 | 执行清单 | 状态 |
| --- | --- | --- | --- |
| RELEASE-001 候选片源理解与推荐 | [Feature](features/RELEASE_SELECTION.md) | [TODO](features/RELEASE_SELECTION_TODO.md) | 待用户审阅，尚未开始实现 |

本功能覆盖电影、电视剧和综艺的范围识别、片源展示、规则排序与按需 AI。整理文档不改变其审批状态。

## 设计参考

- [界面设计规格](design/DESIGN_SPEC.md)
- [发现页设计规格](design/DISCOVERY_SPEC.md)
- `assets/`：项目 README 使用的架构、流程和界面 SVG。

设计规格保留原始设计意图，不保证逐项等于当前 UI。文中引用但未随仓库保存的概念图属于历史参考。

## 历史归档

### AI 方案与实施记录

- [早期调研](archive/ai/AI_RECOMMENDATION_RESEARCH.md)
- [AI-001 原始功能合同](archive/ai/AI_RECOMMENDATION.md)
- [联网推荐重设计进度](archive/ai/AI_REDESIGN_PROGRESS.md)
- [渐进 UI 检查点](archive/ai/AI_PROGRESSIVE_UI.md)
- [搜索适配器阶段记录](archive/ai/AI_SEARCH_ADAPTER.md)

### 已完成路线图与部署证据

- [ROADMAP-001：已完成的五项改进](archive/roadmap/ROADMAP_001.md)
- [2026-09-12 Roadmap-1 部署验收](archive/deployments/DEPLOY_ROADMAP1_20260912.md)
- [2026-09-12 DeepSeek 部署验收](archive/deployments/DEPLOY_DEEPSEEK_20260912.md)

这些文档用于追溯决策和当时验收，不表示现场状态已在整理日重新验证。

## 放置约定

- `docs/` 根目录只保留导航和全局架构说明。
- `operations/` 放运行维护说明；更新现行说明时明确配置适用时间。
- `features/` 将同一功能的 Feature 与 TODO 放在一起，标明编号、日期和审批/实现状态。
- `design/` 放设计规格；`assets/` 放文档图片。
- `archive/ai/`、`archive/roadmap/`、`archive/deployments/` 保存历史阶段材料，保留原始内容并加历史标识。
- 移动文档时同步修改相对链接和项目 README；归档不等于删除，未批准方案不因整理而生效。
