# 第三方组件与数据

- Zotero：本插件调用原生 API。项目 <https://github.com/zotero/zotero>，AGPL-3.0。未打包 Zotero 二进制。
- PDFMathTranslate-next 2.9.0：<https://github.com/PDFMathTranslate/PDFMathTranslate-next>，AGPL-3.0。安装脚本从 Python 包索引安装；不打包用户的现有虚拟环境。
- `service/bing_compat.py` 派生自该版本的 `pdf2zh_next/translator/translator_impl/bing.py`，保留原有引用，增加请求超时及长段落分块，避免只翻译前1000字符。完整修改源码随包提供，适用 AGPL-3.0-only。
- BabelDOC 0.6.2：由 PDF 翻译引擎使用，从包索引安装；请查看其发布包许可证。
- uv：<https://github.com/astral-sh/uv>，MIT / Apache-2.0；自动设置从官方发布下载固定版本并校验 SHA-256。
- Python：通过 <https://github.com/astral-sh/python-build-standalone> 的固定发行版安装，许可证见上游发行内容。
- Ollama / Qwen3:4b：自动设置从官方来源下载独立运行组件和模型；本仓库及 XPI 不包含模型权重。官方来源 <https://github.com/ollama/ollama>（MIT）与 <https://huggingface.co/Qwen/Qwen3-4B>（Apache-2.0）。
- 翻译引擎的缓存和配置路径在独立环境中调整，以避免读取或覆盖用户已有设置；修改逻辑随源码提供。
- Bing：外部翻译服务，不是本项目运营；可用性、限流和服务条款由提供方决定。
- 可选期刊数据来源：<https://github.com/scigreat/addon> 与 <https://www.scigreat.com/s/app/?t=zotbox-vip>。本仓库不打包其期刊记录，也不宣称拥有 JCR、影响因子或中科院分区数据版权。来源授权、准确性、更新年份和服务可用性须独立确认。

“免费、免注册”描述当前配置路径，不承诺任何第三方永久免费或永久可用。没有使用 CiteScore/SJR 冒充 JCR/影响因子。
