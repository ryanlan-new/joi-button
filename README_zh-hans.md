#Joi 按钮

[![Last Commit](https://img.shields.io/github/last-commit/ryanlan-new/joi-button)]()

[[简体中文](/README_zh-hans.md) | [English](README.md)]

![Joi-Button Cover](public/resources/embed/minijoi.png)

一个为 VirtuaReal Liver @轴伊Joi_Channel 制作的语音按钮网站。

[Click here to visit https://space.bilibili.com/61639371](https://space.bilibili.com/61639371)

## 相关链接：

* [Joi 的 Bilibili 频道](https://space.bilibili.com/61639371)
* [项目技术与功能文档](docs/project-tech-and-function.md) —— 2026-07 改造**之前**的快照，作为底稿保留；其中的部署部分已不成立

## 贡献

### 投稿语音

**语音不再通过 Pull Request 投稿。**请使用站点自己的投稿页（页首可进入）。投稿需要验证一次身份：站点发给你一个一次性口令，你把它作为弹幕发在 Joi 的直播间，站点从那条弹幕读到你的 Bilibili open id。投稿不会直接上线，要等站主在审核队列里通过。

这是刻意的设计。语音和随附的描述是别人的东西，而 Pull Request 会把它们写进这个仓库**永久且公开**的历史——事后想撤回，意味着让所有克隆过它的人一起重写历史。数据库可以应要求忘记一次投稿，git 不是为此建的。

[src/voices.json](src/voices.json) 与 [public/voices](public/voices) 是**基线**目录——站点上线时自带的那批语音，由 `server/scripts/import-snapshot.mjs` 在安装时一次性播种进数据库。往这两处加文件不会让它出现在站上：线上目录由 API 从数据库提供，不再来自这个目录。

### 翻译

翻译由站主自行维护，不开放投稿。语言文件是 [src/locales](src/locales) 下的三个 `.js`；每条语音的名称随语音本身走。

### 代码

代码改动仍然欢迎走 Pull Request——fork、改、发起即可。比修 bug 更大的改动，建议先开一个 issue，省得两边都白跑一趟。

## 部署本地开发环境

该网站使用 Vue + jQuery + Bootstrap 3 开发。

要部署本地开发环境，首先安装最新版本的 Node。然后按照以下步骤操作：

1. Clone 代码。

2. 进入代码目录并运行 `npm install`。

3. 运行 `npm run serve`。在代码修改过程中，本地开发服务器可以立即反映修改结果。

4. 要编译前端，请运行 `npm run build`，这将生成 `dist` 目录。

`dist/` 是 web 容器提供的内容，但它已经不是站点的全部：投稿、审核与线上目录由 [server/](server) 里的 API 提供，其数据库与媒体存放在一个共享卷上。两者如何一起跑，见 [deploy/k8s/README.md](deploy/k8s/README.md)。

> 要将您的代码贡献给这个项目，您不必在本地编译。在开发服务器通过测试并推送到 Github 后，您可以直接请求对这个项目的 Pull Request。

## 许可证
[![LICENSE](https://img.shields.io/github/license/ryanlan-new/joi-button)](LICENSE)

Program: MIT

这个项目是粉丝作品，与 VirtuaReal 或 Nijisanji 官方无关。

## 特别感谢

这个项目基于 monoAI 的 [Luna 按钮](https://github.com/monoai) 修改。
