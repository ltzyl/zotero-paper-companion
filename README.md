# Paper Companion · 论文助手

为 Zotero 提供中文阅读、可编辑总结和文库内引用关系图。

![阅读面板与引用关系图示意](docs/demo.svg)

## 功能

- **原文补全**：添加论文后，自动查找可获取的 PDF 原文。
- **中英对照**：英文原文与中文译文分别保存，在两个 Zotero 窗口中独立翻页。
- **划词翻译**：选中文字后，点击“翻译选中文本”。
- **中文标题和摘要**：自动翻译标题及摘要，英文摘要保存为子笔记。
- **总结与简记**：使用本机模型生成可编辑总结及一句话概括。总结列支持悬浮预览和点击编辑。
- **引用关系**：在“相关”面板查看引用与被引文献；点击关系图节点可定位到对应条目。
- **期刊指标**：可选显示影响因子、JCR 和中科院分区，每周检查数据更新。

自动处理个人文库中的论文条目。已有的手工关联、原文、批注和编辑过的总结会保留。

## 安装

环境要求：macOS、Zotero 10、Python 3.12 或更高版本。生成本地总结还需要 Ollama 和 `qwen3:4b` 模型。

1. 从 [Releases](https://github.com/ltzyl/zotero-paper-companion/releases) 下载同一版本的 `.xpi` 和 `paper-companion-runtime-*.zip`。
2. 在 Zotero「工具 → 插件」中安装 `.xpi`。
3. 安装 [Python](https://www.python.org/downloads/) 和 [Ollama](https://ollama.com/download)，然后下载总结模型：

   ```sh
   ollama pull qwen3:4b
   ```

4. 解压运行组件，在解压后的目录运行：

   ```sh
   python3 service/install.py --start
   ```

5. 在 Zotero「工具 → Paper Companion：首次设置与隐私」中，选择服务启动时显示的 `connection.json` 文件，并按需开启期刊指标。

首次安装需要下载翻译引擎及模型。使用翻译和总结时，请保持本机服务与 Ollama 运行；后续启动命令会由安装程序显示。

## 使用

| 操作 | 入口 |
|---|---|
| 打开中英对照 | 右键条目 → 中英双窗口对照 |
| 查看完整总结 | 悬浮“总结”列 |
| 编辑总结 | 点击“总结”列 |
| 编辑简记 | 修改条目 Extra 中的 `remark` |
| 查看引用和被引 | 右侧“相关”面板 |
| 打开当前论文的引用图 | 右侧“引用关系图” |
| 手动加入处理队列、刷新期刊指标 | 工具菜单 |

## 服务与数据

翻译使用 Bing；PDF 正文、标题、摘要及选中文字会发送至该服务。本地总结使用 Ollama，无需模型 API 密钥。完整数据流与本机缓存位置见 [隐私说明](PRIVACY.md)。

原文获取受全文访问权限限制。扫描版 PDF 可能需要额外处理。引用关系来自文库内原文的参考文献匹配，未识别到连线不代表没有引用。期刊指标按第三方来源的版本显示，来源见 [第三方组件与数据](THIRD_PARTY.md)。

## 开发

```sh
node --test tests/*.cjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/build.py
```

构建产物位于 `dist/`。模块说明见 [架构文档](docs/ARCHITECTURE.md)。

## 许可证

[AGPL-3.0-only](LICENSE)。
