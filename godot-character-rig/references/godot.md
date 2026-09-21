# Godot 原生实现与验证

## 与 godot-2d-animation 配合

上游技能是 [thedivergentai/GD-Agentic-Skills 的 godot-2d-animation](https://github.com/thedivergentai/GD-Agentic-Skills/tree/main/skills/godot-2d-animation)。从当前宿主技能目录发现并读取它，不复制整个库，不要求安装所有关联技能。

只看此次任务需要的 cutout / skeletal 内容。加入 IK 时再阅读其相关脚本；外部脚本只是参考，需要核验本地 API、资源和节点路径。例如 `SkeletonModificationStack2D` 必须先存在才能启用，不能对空值访问属性。执行版本以项目和 `godot --version` 为准，不因上游标注某个版本就升级用户项目。

依赖不可用时，本页和官方文档足以继续原生切件绑定。安装指令可使用：

```bash
npx skills add thedivergentai/gd-agentic-skills --skill godot-2d-animation
```

## 先做刚性切件

对大多数已拆分的角色，先把部件挂到 Bone2D 下，旋转骨骼带动贴图。随附 `build_cutout.py` 生成这一版本和 RESET 轨道，保留所有部件为独立 PNG，便于逐件替换。

坐标关系（使用 [manifest 契约](manifest.md) 的零中立旋转、单位缩放）：

```text
Skeleton2D.position = -origin
根骨骼.position = 根骨骼.pivot
子骨骼.position = 子骨骼.pivot - 父骨骼.pivot
Sprite2D.centered = false
Sprite2D.position = image_origin - 所属骨骼.pivot
Sprite2D.scale = Vector2(texture_scale, texture_scale)
```

每根骨骼的 `rest` 等于其中立姿势下的局部 transform；这是相对父节点的变换。保持 Sprite 的 `z_as_relative = false`，使清单中的层级不随骨骼父级叠加。角色内部绝对 z 值需要在接入现有游戏时与场景排序方案协调。

脚本关闭自动计算骨长，并用一个直接子骨骼的方向计算编辑器骨线；多分支显示方向只影响 gizmo。叶骨骼使用短骨线。实际姿势由节点变换决定，不能通过旋转骨骼 gizmo 修正贴图。

场景脚本不生成运动、碰撞体或角色控制器。完整角色任务继续在此基础上完成用户动作；仅验证素材时可用临时试动场景，不把测试动作加入正式动作列表。

## 需要柔性变形时

用 `Polygon2D` 建网格、UV，并指向 Skeleton2D；在肘、膝、尾巴等弯曲区域配置足够的顶点和权重。骨骼列表变动后同步引用，新顶点也要赋权。给各顶点的有效骨骼权重做合理归一化，检查骨路径是否相对正确。

由骨骼驱动网格时，让 Polygon2D 位于角色根下或其他中立容器，避免同时作为活动骨骼子节点再接受骨骼蒙皮，导致双重变换。网格方案和刚性 Sprite 方案可以按部位混用。

## 动画

- AnimationPlayer 为骨骼 `position` / `rotation` 等属性写轨道，保留 RESET 的中立值。旋转单位为弧度。
- 只添加用户指定的动作。没有动作要求时交付 rest pose 与必要的关节试动证据。
- 循环动作首尾兼容；位移和步幅一致，接触地面的脚在支撑阶段保持稳定。
- 需要混合或状态切换时再接 AnimationTree；同一个变换属性保留一个明确的驱动源。
- 需要脚底/手部固定接触时再加 IK，先确认目标引擎的 2D IK API。整体镜像时连同骨骼、部件及附着点处理，检查非对称图案与武器左右。

## 验证与证据

在目标项目运行必要的导入和场景加载检查；这里的路径仅是示例：

```bash
godot --version
godot --headless --editor --path /path/to/game --quit
godot --headless --path /path/to/game res://characters/hero/hero-rig.tscn --quit-after 2
```

还要查看日志。某些脚本错误不可靠地反映在进程退出码里；headless 的结构成功不证明美术正确。需要完成：

1. **原位回拼**：静止姿势与原图对照，检查比例、面部、衣服纹理、PNG 偏移及前后层级。
2. **关节试动**：在动作实际使用的弯曲范围测试肩/肘/髋/膝，检查露缝、贴图断开和遮挡错误。优先测试最可能失败的关节。
3. **恢复中立姿势**：动作后应用 RESET，确认每根骨骼和部件回到原位。
4. **实际动作**：用户要求的循环、攻击或手势逐一播放，检查接地、道具附着以及循环接缝。

使用当前环境可用的 Godot 编辑器、截图或渲染工具获取预览并查看。缺少图形/渲染能力时，标明视觉检查未完成，并保留可打开的预览场景，不声称已经通过。

`build_cutout.py` 在 Godot 4.7.2 做过合成素材的加载、坐标和 RESET 检查。具体用户素材仍需要以上视觉验证；其他项目版本也应实际加载验证。

## 官方资料

- [Cutout animation](https://docs.godotengine.org/en/stable/tutorials/animation/cutout_animation.html)
- [2D skeletons](https://docs.godotengine.org/en/stable/tutorials/animation/2d_skeletons.html)
- [Bone2D](https://docs.godotengine.org/en/stable/classes/class_bone2d.html)
- [Sprite2D](https://docs.godotengine.org/en/stable/classes/class_sprite2d.html)
- [Polygon2D](https://docs.godotengine.org/en/stable/classes/class_polygon2d.html)

查看与你的引擎版本相匹配的文档；stable 文档可能已经切换到另一个版本。
