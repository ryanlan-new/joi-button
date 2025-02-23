#Joi 按钮

[![Last Commit](https://img.shields.io/github/last-commit/ryanlan-new/joi-button)]()

![Joi-Button Cover](public/resources/embed/minijoi.png)

[[简体中文](/README_zh-hans.md) | [English](README.md)]

一个为 VirtuaReal Liver @轴伊Joi_Channel 制作的语音按钮网站。

[Click here to visit https://space.bilibili.com/61639371](https://space.bilibili.com/61639371)

## 相关链接：

* [Joi 的 Bilibili 频道](https://space.bilibili.com/61639371)

## 贡献

请 fork 这个项目进行修改，完成修改后，在这个项目中发起 Pull Request。

### 添加或修改语音

**描述**：所有语音的元信息都存储在 [src/voices.json](src/voices.json) 中。要添加或修改这些语音，您需要相应地修改此文件。

语音始终为 mp3 格式，存储在 [public/voices](public/voices) 中。对应的 URL 是 `voices/`。

对于新的语音，请使用 MP3GainGUI 等软件进行音量标准化。目前的音量标准化值为 80。

请注意，对于这个项目，我们特别按照这种模式对语音进行分类：`CATEGORY_VOICENAME.mp3`。一个合适的文件名示例是 `Cute Hummings_Ei?.mp3`，其中 `Cute Hummings` 代表 `Cute Hummings` 类别，而 `Ei?` 代表语音名称。它不必完全转录台词，只要便于查找即可。请查看 [voices.json](src/voices.json) 了解更多信息。

由于该网站使用了强缓存策略，除了 `index.html`，具有相同文件名的文件，即使被修改，客户端也**永远**不会刷新。因此，无论是新的还是修改过的语音文件，其文件名**必须**与之前的任何文件名不同。

如果您正在修改语音，请在修改后删除原始文件。

### 参与翻译

请帮助我们翻译成可用的语言！（us_en/ja_jp/zh_cn）

主程序的语言文件位于 [src/locales](src/locales) 中三个以语言名称命名的 .js 文件中。

语音的语言文件位于 [src/voices.json](src/voices.json) 中。

国家旗帜位于 [src/App.vue](src/App.vue) 中，以防实现新语言。

相应的修改可以被程序识别为有效的翻译。

## 部署本地开发环境

该网站使用 Vue + jQuery + Bootstrap 3 开发。

要部署本地开发环境，首先安装最新版本的 Node。然后按照以下步骤操作：

1. Clone 代码。

2. 进入代码目录并运行 `npm install`。

3. 运行 `npm run serve`。在代码修改过程中，本地开发服务器可以立即反映修改结果。

4. 要编译文件以进行部署，请运行 `npm run build`，这将生成 `dist` 目录。该网站是完全静态的，您可以直接部署整个 `dist` 目录。

> 要将您的代码贡献给这个项目，您不必在本地编译。在开发服务器通过测试并推送到 Github 后，您可以直接请求对这个项目的 Pull Request。

## 许可证
[![LICENSE](https://img.shields.io/github/license/ryanlan-new/joi-button)](LICENSE)

Program: MIT

这个项目是粉丝作品，与 VirtuaReal 或 Nijisanji 官方无关。

## 特别感谢

这个项目基于 monoAI 的 [Luna 按钮](https://github.com/monoai) 修改。