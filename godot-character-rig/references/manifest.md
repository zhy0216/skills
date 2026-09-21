# 素材与坐标契约

这是本技能的交接格式，由 `scripts/build_cutout.py` 消费；不是 Godot 自带的格式。

## 坐标约定

- 全部位置使用原图像素坐标：左上为 `(0, 0)`，X 向右，Y 向下。
- `origin` 是场景原点在原图中的位置，通常取脚底中心；角色场景中的点为 `原图坐标 - origin`。
- `bones[].pivot` 是关节在原图中的绝对坐标。`parent` 是另一个骨骼 ID，唯一根骨骼使用 `null`。JSON 顺序可以不按父子排列。
- `parts[].image_origin` 是最终 PNG 左上角在原图中的位置，包含透明边距的影响；允许负值。
- `size` 是实际 PNG 尺寸，包含透明边距。`texture_scale` 是 PNG 像素到原图像素的等比缩放，默认 `1`；例如生成部件是原图的两倍大小，设为 `0.5`，无需重采样 PNG。画面朝向仍沿用原图。
- 所有骨骼中立旋转为 0、缩放为 1；图像本身保留原画姿态。显示用的 bone angle 不参与坐标换算。
- `z_index` 越大越靠前；绘制顺序与骨骼父子关系分开。避免把需要稳定前后顺序的重叠部件设成相同值。
- 骨骼/部件 ID 使用小写字母开头的 `snake_case`。左右始终指角色自身。

原画中躯干 pivot 在 `(256, 320)`、上臂 pivot 在 `(200, 180)`，则上臂相对躯干的位置为 `(-56, -140)`。若上臂 PNG 左上角是 `(180, 160)`，Sprite 在上臂骨骼下的位置为 `(-20, -20)`，并设 `centered = false`。

PNG 内点 `p` 对应的原图位置为 `image_origin + texture_scale * p`。`image_origin` 已经处于原图坐标系，不再乘以该缩放；透明留白也按这个公式换算。

## 示例

下面是躯干与一条手臂的小样结构；尺寸和坐标是示例，需要用实际测量值替换，并准备对应 PNG。

```json
{
  "schema_version": 1,
  "name": "HeroRig",
  "source_image": "res://art/hero/source.png",
  "canvas_size": [512, 768],
  "origin": [256, 700],
  "bones": [
    {"id": "torso", "parent": null, "pivot": [256, 320]},
    {"id": "upper_arm_l", "parent": "torso", "pivot": [200, 180]},
    {"id": "forearm_l", "parent": "upper_arm_l", "pivot": [188, 280]}
  ],
  "parts": [
    {
      "id": "torso",
      "bone": "torso",
      "texture": "res://art/hero/parts/torso.png",
      "image_origin": [190, 150],
      "size": [132, 220],
      "z_index": 0,
      "method": "generated",
      "notes": "补齐左臂挡住的衣服区域；可见纹理已回拼检查"
    },
    {
      "id": "upper_arm_l",
      "bone": "upper_arm_l",
      "texture": "res://art/hero/parts/upper_arm_l.png",
      "image_origin": [180, 160],
      "size": [48, 140],
      "z_index": 10,
      "method": "generated"
    },
    {
      "id": "forearm_l",
      "bone": "forearm_l",
      "texture": "res://art/hero/parts/forearm_l.png",
      "image_origin": [168, 260],
      "size": [48, 130],
      "z_index": 20,
      "method": "generated"
    }
  ]
}
```

## 字段要求

| 字段 | 说明 |
| --- | --- |
| `schema_version` | 当前为整数 `1` |
| `name` | 可选，场景根节点名，默认 `CharacterRig`；字母/下划线开头，其后可带数字 |
| `source_image` | 有原图时写项目内真实文件路径；仅已有切件时可省略或为 null |
| `canvas_size` | 两个正整数；没有原图时定义一张用于组合的参考画布 |
| `origin` | 两个有限数值 |
| `bones` | 非空，ID 唯一，无环、无丢失父节点且只有一个根 |
| `parts` | 非空；ID 唯一，所属骨骼存在，PNG 存在，声明尺寸与文件一致 |
| `texture_scale` | 部件内可选，默认 `1`；正的有限数值，表示贴图到原图的等比缩放 |
| `method` | 必填，`extracted` 表示直接提取；`generated` 表示生成/重绘；`hybrid` 表示经合成保留可见像素并补画 |
| `notes` | 可选；记录补画范围、未解决的遮挡或拆分限制 |

纹理路径必须是项目内的 `res://` 路径。脚本只验证 PNG 文件头和尺寸；解码完整性、实际 alpha、像素一致性和艺术效果由后续引擎加载与视觉检查确认。

所有输入都准备好后，先用 `--check` 检查，再生成初始场景。输出包含 `Skeleton2D/bone_<id>` 层级、每个骨骼下的 `part_<id>` Sprite，以及 `AnimationPlayer` 的 RESET。根据骨骼层级查找完整动画路径，不能假设每根骨骼都直接位于 Skeleton2D 下。

柔性网格、部件非等比缩放/额外旋转、IK、动画关键帧不属于 v1 清单。需要这些内容时，在生成的初始场景中继续编辑并保存，而不是添加脚本会忽略的字段。额外注释元数据可留在 JSON 中。
