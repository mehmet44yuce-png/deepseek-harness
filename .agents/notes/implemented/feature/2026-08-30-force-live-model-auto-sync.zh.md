# 代理说明：强制实时模型同步让 NVIDIA 目录无需手动刷新即保持最新

状态：已实现

[English](2026-08-30-force-live-model-auto-sync.md) | 中文

## 问题

一个 NVIDIA NIM 账户获得了新模型，但 DeepSeek Harness 的模型选择没有反映它们。
pi-ai 适配器针对 **静态已安装目录**（pi-ai `^0.84.2`）回答某个目录路由，不发起网络
调用，因此针对 `nvidia` 的 `llm/discoverModels` 返回的是打包的 18 个模型注册表，
而不是实时的 `https://integrate.api.nvidia.com/v1/models` 列表（其对外宣称约 100+）。

在该结账推进到 `0.1.2-alpha.1` 时，一个早期的磁盘特性（手动“刷新模型”按钮 + 一个
`forceLive` 线上字段）被回退。用户反馈“模型在框架更新后消失了”，这被读作数据丢失。

对照真实环境验证过：模型新增项**并未**丢失。它们位于 `~/.dsh/settings.yaml`
（用户设置层，位于仓库之外），适配器仍然全部服务这 103 个（`listModels('nvidia')`）。
更新抹掉的是**磁盘上的特性代码**，而不是模型数据。因此真正的需求有两方面：重新提供
一种更新机制，并让持久化保证变得明确。

## 决定

1. **`LlmModelDiscoveryRequest` 上的 `forceLive?: boolean`**（`packages/llm/llm/src/types.ts`）。
   某条目录路由的查询想要端点的当前列表，因此当设置 `forceLive` 时 `discovery.ts`
   会跳过目录短路，并在请求未指定时回退到目录提供方自己的基址
   （`catalogProvider(provider)?.baseUrl`）——这样无需在请求中带基址，即可针对 `nvidia`
   实时询问其自身端点。

2. **自动同步（选项 C，默认为关闭）** 位于 `ModelsSettingsStore.syncModelsNow()`：
   在一次成功的 `load()` 之后，每条已配置的 pi-ai 路由都会被强制实时询问，其新模型
   通过 `settings.mutate` **只增**地写入该路由的 `models` 列表。已有条目（包括用户微调
   过的容量）会原样保留且绝不重复；已经服务某模型的路由保持不变。`dsh.modelsSettings.autoSync`
   localStorage 开关（默认关闭）控制它，页面开关切换它。默认为关闭是因为该操作会在每次
   页面加载时通过线缆询问每条已配置的 pi-ai 端点——选择加入才能把这种网络开销放在明确
   的选择之后。

3. **故障隔离。** 无法探测的路由（没有目录、没有基址、协议错误）会按路由逐条报告，绝不
   让整个操作失败；页面显示新增数量或拒绝文本。

## 持久化保证

模型新增项写入**用户设置层**（`~/.dsh/settings.yaml`），它位于仓库之外。框架更新会
重写应用包和基础/组合层，而不是这个文件，因此用户新增项得以保留。那一轮“感知到丢失”
实为特性**代码**回退；数据是完整的。自动同步会在下次打开页面时重新加入任何缺失项，并在
NVIDIA 增加模型时保持目录最新。
