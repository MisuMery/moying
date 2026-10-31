// 通勤 / 位置决策（纯函数，便于单测）。
//
// 通勤必须是两步：家 ↔ 路上(transit) ↔ 公司，且「到站」必须等进入 transit 满
// commuteMinutes。之前引擎一步 home→office 直接落死，导致「一出门就到公司」，
// 世界阶段还会写出「出门去公司 / 出地铁站」和「已到公司」互相打架。
import { Place, isAway } from '../world/state.js';

export function commuteStep({ place, h, isWorkday, sc, enteredHour, sinceEnter, homeException = false }) {
  const commuteH = (sc.commuteMinutes || 0) / 60;
  const commuteMs = (sc.commuteMinutes || 0) * 60000;

  // ① 深夜/凌晨（23:00–次日 7:00）：不管在哪，直接回家睡觉
  if (isAway(place) && (h >= 23 || h < 7)) {
    return { from: place, to: Place.HOME, summary: h >= 23 ? '深夜回家' : '回家' };
  }

  if (isWorkday) {
    // ② 早上出门：家 → 路上（提前半小时开窗，避免 20 分钟一拍错过出门点导致迟到；
    //    过了上班两小时就不再强行出门）
    if (place === Place.HOME && !homeException && h >= sc.from - commuteH - 0.5 && h < sc.from + 2) {
      return { from: Place.HOME, to: Place.TRANSIT, summary: '出门上班，路上通勤' };
    }
    // ②b 上班前却滞留在「别处/公园/商场/聚会」这种不该在的地方 → 先回家准备上班
    //     （历史遗留：旧版一步 home→office 又被叙事改成 other，会把人卡在别处一整夜/一早）
    if (h < sc.from && [Place.OTHER, Place.PARK, Place.MALL, Place.OUTSIDE].includes(place)) {
      return { from: place, to: Place.HOME, summary: '回家' };
    }
    // ②c 工作日上班时段却滞留在「别处/公园/商场/聚会」→ 回公司（餐馆/超市/办事属于午休杂事，不在此列）
    if (h >= sc.from && h < sc.to && [Place.OTHER, Place.PARK, Place.MALL, Place.OUTSIDE].includes(place)) {
      return { from: place, to: Place.TRANSIT, summary: '回公司' };
    }
    // ③ 早上到站：路上 → 公司（必须走过通勤时间）
    if (place === Place.TRANSIT && enteredHour >= sc.from - commuteH - 0.5 && enteredHour < sc.from + 3 && sinceEnter >= commuteMs) {
      return { from: Place.TRANSIT, to: Place.OFFICE, summary: '到公司' };
    }
    // ④ 傍晚下班：公司 → 路上
    if (place === Place.OFFICE && h >= sc.to) {
      return { from: Place.OFFICE, to: Place.TRANSIT, summary: '下班，路上' };
    }
    // ⑤ 傍晚到家：路上 → 家（走过通勤时间）
    if (place === Place.TRANSIT && enteredHour >= sc.to - 0.5 && enteredHour < sc.to + 2.5 && sinceEnter >= commuteMs) {
      return { from: Place.TRANSIT, to: Place.HOME, summary: '到家' };
    }
  } else if (place === Place.OFFICE) {
    // ⑥ 非工作日还待在公司 = 遗留状态，回家
    return { from: Place.OFFICE, to: Place.HOME, summary: '休息日回家' };
  }
  return null;
}
