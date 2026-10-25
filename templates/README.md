# 标准格式模板

这五份是**空模板**（不含任何具体角色内容），新装从这里起步：

```bash
node scripts/init-data.js      # 复制到 data/ 下，已存在的不覆盖
```

| 文件 | 回答什么 | 关键点 |
|---|---|---|
| `character.template.json` | 她是谁 | 只写角色本体，不写她跟任何人的关系 |
| `cast.template.json` | 配角是谁 | `presence.places` 决定能出现在哪些地点 |
| `user.template.json` | 对方是谁 | 只写中性事实，感情深浅不写在这里 |
| `world.template.json` | 世界是什么 | `preset=default` 就是现实世界 |
| `relationship.template.json` | 她和这个人到了哪一步 | 只填 `kind` 与 `initialMode`，其余交给 AI 演化 |

## 三条容易踩的坑

1. **感情深浅只写一次**：写在 `relationship.json`，别在 `user.json` 里也写一遍，两份会打架。
2. **各阶段的相处方式不要手写**：填好 `initialMode` 就够了，进档时世界模型会按剧情推演；手动改过的档会被标记 `manual`，自动演化会跳过（可在控制台强制重写）。
3. **红线要能被解除**：`relationship.json` 每档的 `relaxKeywords` 会命中并解除 `character.json` 里的红线。比如依赖档解除「不许表白」，角色卡的红线里就必须有「表白」这个词才能被命中。

## 字段说明

各字段的含义见主 [README](../README.md) 的「目录结构」一节，以及每份模板里的 `_note` 字段；填好的文件可以在控制台「用户与关系」页在线查看和调整。
