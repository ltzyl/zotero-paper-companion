# 功能模块注释

- `public-config.js`：首次启用说明、连接文件验证、划词翻译按钮、无其他插件时补充标题/简记列。仅允许127.0.0.1。
- `workflow.js` / `core.js`：新论文防重复排队、正文候选检查、原文获取、单语中文译文导入。任务ID持久化，连接中断查询原任务。
- `metadata.js` / `metadata-core.js`：本地结构化总结、可编辑子笔记、行下悬浮。已存在笔记不自动重写，材料范围显式标记。
- `enrichment.js`：作者摘要翻译前备份；异步返回后再次检查用户是否修改；用户改过的摘要进入保护状态。空简记才自动填充。
- `references-core.js` / `companions.js`：只在参考文献区匹配DOI或保守完整标题；保存 source→target。有重复DOI的条目不互相产生自引用。
- `reading-pane.js`：包装原生“相关”渲染并保留手工关联；注册原生自定义图谱区；选择节点直接调用 Zotero 条目选择API。
- `metrics-*`：来源版本校验、ISSN/标题冲突检测、原子更新与失败回退。安装包只有空数据结构，不含第三方期刊记录。
- `service/server.py`：随机令牌的本机HTTP桥接。原文文件名不进入shell命令，输出路径由内部UUID生成；拒绝跨源浏览器调用。
- `installer.js` / `installer-core.js`：原生自动设置、下载校验、按 Zotero 配置隔离安装、取消与进程所有权管理。`setup.xhtml` 提供安装和运行状态界面。
- `service/manager.py`：管理固定版本的 Python 引擎、资源及本地模型，验证完整运行条件后发布连接信息；跟随 Zotero 生命周期。
- `service/engine_probe.py`：检查翻译依赖与资源，并使用虚构 PDF 验证中文输出。
- `service/install.py`：在独立venv安装固定版本引擎，不读取Zotero数据库或个人配置。

同一台电脑可同时保留个人定制版和公共源文件；公共版使用独立插件ID与状态文件名。实际安装两个自动化插件会重复处理，因此普通用户应只启用一个。
