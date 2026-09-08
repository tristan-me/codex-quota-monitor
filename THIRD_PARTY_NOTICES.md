# Third-party data notices / 第三方数据告知

Last reviewed / 最后核查：2026-09-08

This file documents external reference data used by the plugin. It does not
grant any additional permission and is not a legal opinion.

本文件只说明插件使用的外部参考数据，不授予任何额外许可，也不是法律意见。

## License boundary / 许可证边界

The MIT license in [`LICENSE`](./LICENSE) applies to this project's source
code and project-authored documentation only. It does **not** relicense or
grant rights in third-party API responses, website text, post text, charts,
images, logos, trademarks, or other source-owned material bundled as a dated
reference snapshot.

根目录 [`LICENSE`](./LICENSE) 中的 MIT 许可只适用于本项目源代码和项目自有文档，**不**对第三方 API 响应、网站文案、原帖文字、图表、图片、标志、商标或随项目保存的日期化参考快照重新授权。

Public access, a JSON endpoint, no API key, or CORS support is technical
access information. It is not by itself a copyright license, commercial
redistribution grant, or permission to mirror the source.

公开访问、JSON endpoint、无需 key 或允许跨源读取只说明技术访问方式，不等于版权许可、商业再分发授权或整站镜像许可。

## Codex Reset / codex-reset.com

Source pages and endpoints / 来源页面与接口：

- [Terms of Use](https://codex-reset.com/terms)
- [Privacy](https://codex-reset.com/privacy)
- [Release Notes](https://codex-reset.com/codexreset-release)
- [Public JSON and citation guidance](https://codex-reset.com/llms-full.txt)
- [Timeline API](https://codex-reset.com/api/timeline)
- [Forecast API](https://codex-reset.com/api/forecast)

The site describes itself as an independent community project. The two
public JSON endpoints used here support GET reads without a key and allow
cross-origin access. Its citation guidance asks consumers to cite the canonical page or
JSON endpoint, name “Codex Reset (codex-reset.com),” and retain the source
update/observation timestamp. Its privacy page says the site's own radar
republishes short public-post excerpts for commentary and news reporting.

该站说明自己是独立社区项目；本插件使用的两个公开 JSON 接口支持无需 key 的 GET 与跨源读取。引用说明要求链接 canonical 页面或 JSON endpoint、注明“Codex Reset (codex-reset.com)”并保留来源更新时间/观察时间。隐私页说明站点自身会为评论和新闻报道发布公开帖子的短摘录。

In the pages checked on the date above, no explicit open-data license,
commercial reuse permission, full-archive redistribution license, or numeric
rate-limit policy was found. This absence does not prove reuse is forbidden,
but the project makes no claim that commercial permission has been granted.

在上述日期核查的页面中，未找到明确的开放数据许可证、商业复用许可、完整归档再分发许可或数字化频率上限。未找到许可不等于已证明禁止复用；本项目也不宣称已经取得商业许可。

The plugin uses low-frequency anonymous GET requests, caches the normalized
result, keeps only the two latest public announcements, paraphrases where
possible, and links to the original post/source timestamp. It does not send
account credentials or user data to this source.

插件以低频匿名 GET 刷新并缓存规范化结果，只保留最近两条公开公告，尽量使用改写并保留原帖/来源时间链接；不会向该来源发送账号凭据或用户数据。

## Codex Radar / codexradar.com

Source pages and endpoint / 来源页面与接口：

- [Model ratings page](https://codexradar.com/#model-ratings)
- [Privacy Policy](https://codexradar.com/privacy/)
- [Distributed Radar client repository](https://github.com/codex-radar/dradar)
- [Public intelligence endpoint used by the reference snapshot](https://api.codexradar.com/api/v1/intelligence-efficiency)

The model page describes the preview as DeepSWE/community-tested data and
labels IQ and duration as comparable while cost is a reference/equivalent
cost. The privacy page covers hosting, local preferences, and optional
community ratings; it does not publish a data reuse or commercial license.

模型页将预览描述为 DeepSWE/社区众测数据，并称 IQ 与耗时可比较、费用属于参考/等效成本。隐私页说明托管、本地偏好和主动提交的社区评分，但没有发布数据复用或商业许可证。

The linked DRadar repository describes an open-source client, but the checked
repository tree did not expose a `LICENSE` file and its `pyproject.toml` did
not declare a license field. Code openness does not grant rights in the site's
data, marks, page text, or images.

该 DRadar 仓库说明客户端是开源项目，但本次核查的仓库文件树没有看到 `LICENSE` 文件，`pyproject.toml` 也没有声明 license 字段。客户端代码的开放性不等于网站数据、商标、页面文案或图片获得授权。

No Codex Radar data license, commercial reuse permission, attribution policy,
or documented rate limit was found in the checked first-party pages. The
plugin therefore treats the model JSON as a dated third-party reference
snapshot, not as MIT-licensed project data or an authorized mirror.

在核查的第一方页面中，未找到 Codex Radar 数据许可证、商业复用许可、署名政策或公开频率限制。因此插件将模型 JSON 视为带日期的第三方参考快照，而不是 MIT 许可项目数据或已获授权的镜像。

## Attribution and scope / 署名与范围

The plugin is an independent community project and is not affiliated with or
endorsed by OpenAI, Codex Reset, or Codex Radar. “OpenAI,” “Codex,” and
“ChatGPT” remain the marks of their respective owners. Original post authors,
the two source sites, and any other rights holders retain their own rights.

本插件是独立社区项目，与 OpenAI、Codex Reset、Codex Radar 均无关联或背书关系。“OpenAI”“Codex”“ChatGPT”仍属于各自权利人；原帖作者、两个来源站点及其他权利人保留其相应权利。

For commercial distribution, high-frequency polling, full-history mirroring,
or republishing substantial source text or visual assets, obtain a separate
written permission or license before proceeding.

如需商业分发、高频轮询、完整历史镜像，或重新发布大量原文/视觉素材，应先取得单独的书面许可或授权。
