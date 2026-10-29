# 第三方组件与数据

- Zotero：本插件调用原生 API。项目 <https://github.com/zotero/zotero>，AGPL-3.0。未打包 Zotero 二进制。
- PDFMathTranslate-next 2.9.0：<https://github.com/PDFMathTranslate/PDFMathTranslate-next>，AGPL-3.0。安装脚本从 Python 包索引安装；不打包用户的现有虚拟环境。
- `service/bing_compat.py` 派生自该版本的 `pdf2zh_next/translator/translator_impl/bing.py`，保留原有引用，增加请求超时及长段落分块，避免只翻译前1000字符。完整修改源码随包提供，适用 AGPL-3.0-only。
- BabelDOC 0.6.2：由 PDF 翻译引擎使用，从包索引安装；请查看其发布包许可证。
- Ollama / Qwen3:4b：由用户自行安装、下载；本仓库不重新分发模型权重。官方来源 <https://ollama.com> 与 <https://huggingface.co/Qwen>。
- Bing：外部翻译服务，不是本项目运营；可用性、限流和服务条款由提供方决定。
- 可选期刊数据来源：<https://github.com/scigreat/addon> 与 <https://www.scigreat.com/s/app/?t=zotbox-vip>。本仓库不打包其期刊记录，也不宣称拥有 JCR、影响因子或中科院分区数据版权。来源授权、准确性、更新年份和服务可用性须独立确认。

“免费、免注册”描述当前配置路径，不承诺任何第三方永久免费或永久可用。没有使用 CiteScore/SJR 冒充 JCR/影响因子。
