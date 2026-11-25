-- 导出当前地图的地面高度和树（给敌方眼位的视野模型用，见 tools/map_dump.py 和 docs/design/wards.md）。
--
-- 在 Dota 2 Workshop Tools 里用正式地图跑这个自定义游戏：
--     dota_launch_custom_game map_dump dota
-- 工具要带 -condebug 启动，控制台才会落盘到 game/dota/console.log（con_logfile 在工具里是 Unknown command）。
-- 脚本逐行打印：
--     MAPDUMP BEGIN <cell> <x0> <y0> <w> <h>       网格：格子边长、左下角格子的左下角坐标、列数、行数
--     MAPDUMP H <row> <col0> <z> <z> ...           一行里从 col0 开始的一段格子中心的地面高度（取整）
--     MAPDUMP T <x> <y> <z> <standing>             每棵树
--     MAPDUMP END <trees>
-- Lua 沙箱里没有文件 io，只能借控制台日志落盘；一行太长控制台会截断，所以一行只打 64 格。
-- 一帧里查十万次高度会触发脚本超时，所以分帧：每次 think 做几行。

-- 网格和 maps/dota.gnv 对齐（64 码一格，320 × 328 格，左下角 -10240, -10752），方便和寻路网格叠在一起看
local CELL, X0, Y0, W, H = 64, -10240, -10752, 320, 328
local CHUNK, ROWS_PER_THINK = 64, 4

if MapDump == nil then
  MapDump = class({})
end

function Activate()
  GameRules.MapDump = MapDump()
  GameRules.MapDump:Init()
end

function MapDump:Init()
  self.stage = "heights"
  self.row = 0
  GameRules:GetGameModeEntity():SetThink("Step", self, "map_dump", 1)
end

function MapDump:Step()
  if self.stage == "heights" then
    if self.row == 0 then
      print(string.format("MAPDUMP BEGIN %d %d %d %d %d", CELL, X0, Y0, W, H))
    end
    for _ = 1, ROWS_PER_THINK do
      if self.row >= H then break end
      local y = Y0 + CELL * self.row + CELL / 2
      for col0 = 0, W - 1, CHUNK do
        local vals = {}
        for col = col0, math.min(col0 + CHUNK, W) - 1 do
          local x = X0 + CELL * col + CELL / 2
          vals[#vals + 1] = string.format("%d", math.floor(GetGroundHeight(Vector(x, y, 0), nil) + 0.5))
        end
        print(string.format("MAPDUMP H %d %d %s", self.row, col0, table.concat(vals, " ")))
      end
      self.row = self.row + 1
    end
    if self.row < H then return 0.03 end
    self.stage = "trees"
    return 0.1
  end

  if self.stage == "trees" then
    local trees = GridNav:GetAllTreesAroundPoint(Vector(0, 0, 0), 20000, true) or {}
    for _, t in ipairs(trees) do
      local p = t:GetAbsOrigin()
      local standing = (t.IsStanding == nil or t:IsStanding()) and 1 or 0
      print(string.format("MAPDUMP T %d %d %d %d", math.floor(p.x + 0.5), math.floor(p.y + 0.5), math.floor(p.z + 0.5), standing))
    end
    print(string.format("MAPDUMP END %d", #trees))
    self.stage = "done"
    return nil
  end
  return nil
end
