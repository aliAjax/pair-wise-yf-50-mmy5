import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成" | "已撤销";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string; // 指派小组
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
  // 执行回执（当前调度周期的回填状态）
  claimedBy: string; // 实际领取小组（离线领取时记下）
  claimedAt: string | null;
  arrivedAt: string | null; // 首次到场时间
  arrivalNote: string; // 到场说明
  completedAt: string | null; // 末次完成时间
  completionNote: string; // 完成说明
  revokedAt: string | null;
  receiptResetAt: string | null; // 撤销退回待接收的时点；此前周期的回执不再参与合并
  version: number;
  deviceUpdatedAt: string;
}

// 执行回执：队员离线领取/到场/完成时回填，联网后上传合并
export interface Receipt {
  id: string;
  taskId: string;
  householdId: string;
  group: string; // 执行 / 领取小组
  claimedAt: string | null;
  arrivedAt: string | null;
  arrivalNote: string;
  completedAt: string | null;
  completionNote: string;
  deviceId: string;
  uploadedAt: string | null;
  createdAt: string;
}

export interface PendingChange {
  id: string;
  entity: string;
  action: string;
  detail: string;
  time: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: string;
  remoteValue: string;
  status: "待处理" | "采用本地" | "采用远端";
}

const KEY = "pair-wise-yf-50/assessment";
const now = () => new Date().toISOString();
const minBefore = (mins: number) => new Date(Date.now() - mins * 60000).toISOString();

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: minBefore(12), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: minBefore(35), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: now(), note: "疑似重复登记" }
];

const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00", claimedBy: "后勤二组", claimedAt: minBefore(40), arrivedAt: minBefore(30), arrivalNote: "已到新城三街9号楼下，饮用水可卸", completedAt: null, completionNote: "", revokedAt: null, receiptResetAt: null, version: 1, deviceUpdatedAt: minBefore(30) },
  { id: "k2", householdId: "h2", title: "配送慢病用药", assignee: "医疗组", priority: "紧急", status: "已完成", due: "2026-09-29 12:00", claimedBy: "医疗组", claimedAt: minBefore(180), arrivedAt: minBefore(150), arrivalNote: "已上门核对药品与服用方法", completedAt: minBefore(120), completionNote: "药品已交付并告知服用方法", revokedAt: null, receiptResetAt: null, version: 1, deviceUpdatedAt: minBefore(120) }
];

const seedReceipts: Receipt[] = [
  { id: "r1", taskId: "k1", householdId: "h2", group: "后勤二组", claimedAt: minBefore(40), arrivedAt: minBefore(30), arrivalNote: "已到新城三街9号楼下，饮用水可卸", completedAt: null, completionNote: "", deviceId: "local", uploadedAt: null, createdAt: minBefore(40) },
  { id: "r2", taskId: "k2", householdId: "h2", group: "医疗组", claimedAt: minBefore(180), arrivedAt: minBefore(150), arrivalNote: "已上门核对药品与服用方法", completedAt: minBefore(120), completionNote: "药品已交付并告知服用方法", deviceId: "local", uploadedAt: null, createdAt: minBefore(180) }
];

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const receipts = ref<Receipt[]>(initial?.receipts ?? seedReceipts);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? now());
  const syncing = ref(false);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status === "待接收" || item.status === "进行中").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function enqueue(entity: string, action: string, detail: string) {
    queue.value.unshift({ id: crypto.randomUUID(), entity, action, detail, time: now() });
  }

  // 派工任务状态更新后，家庭状态跟着重算：还有没做完的任务就不算完成
  function recalcHouseholdStatus(householdId: string) {
    const household = households.value.find((item) => item.id === householdId);
    if (!household) return;
    const list = tasks.value.filter((item) => item.householdId === householdId);
    if (!list.length) return;
    const hasOpen = list.some((item) => item.status === "待接收" || item.status === "进行中");
    if (hasOpen) {
      if (household.status !== "已分派") household.status = "已分派";
    } else if (list.some((item) => item.status === "已完成")) {
      if (household.status !== "已完成") household.status = "已完成";
    }
    // 全部作废等边界情况保持原状，不臆造状态
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    households.value.unshift({ ...input, id: crypto.randomUUID(), status: "待评估", version: 1, deviceUpdatedAt: now() });
    enqueue("家庭需求记录", "新增", input.head);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: now() });
    enqueue("家庭需求记录", "修改", `${household.head}：${Object.keys(patch).join("、")}`);
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    // 一并转移未完成的派工任务，再重算家庭状态
    tasks.value.forEach((task) => {
      if (task.householdId === sourceId) task.householdId = targetId;
    });
    receipts.value.forEach((receipt) => {
      if (receipt.householdId === sourceId) receipt.householdId = targetId;
    });
    households.value = households.value.filter((item) => item.id !== sourceId);
    recalcHouseholdStatus(targetId);
    enqueue("重复记录", "合并", `${source.head} → ${target.address}`);
  }

  function addTask(input: Omit<FieldTask, "id" | "status" | "claimedBy" | "claimedAt" | "arrivedAt" | "arrivalNote" | "completedAt" | "completionNote" | "revokedAt" | "receiptResetAt" | "version" | "deviceUpdatedAt">) {
    const task: FieldTask = {
      ...input,
      id: crypto.randomUUID(),
      status: "待接收",
      claimedBy: "",
      claimedAt: null,
      arrivedAt: null,
      arrivalNote: "",
      completedAt: null,
      completionNote: "",
      revokedAt: null,
      receiptResetAt: null,
      version: 1,
      deviceUpdatedAt: now()
    };
    tasks.value.unshift(task);
    recalcHouseholdStatus(task.householdId);
    enqueue("任务", "分派", `${task.title} / ${task.assignee}`);
  }

  // 队员离线领取：记下实际领取小组，任务进入进行中
  function claimTask(id: string, group: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task || task.status !== "待接收") return;
    const g = (group || "").trim() || task.assignee;
    task.status = "进行中";
    task.claimedBy = g;
    task.claimedAt = now();
    task.deviceUpdatedAt = now();
    upsertLocalReceipt(task, { group: g, claimedAt: task.claimedAt });
    recalcHouseholdStatus(task.householdId);
    enqueue("任务", "领取", `${task.title} / ${g}`);
  }

  // 到场回填时间与说明
  function arriveTask(id: string, note: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task || task.status !== "进行中" || task.arrivedAt) return;
    task.arrivedAt = now();
    task.arrivalNote = (note || "").trim();
    task.deviceUpdatedAt = now();
    upsertLocalReceipt(task, { arrivedAt: task.arrivedAt, arrivalNote: task.arrivalNote });
    enqueue("任务", "到场", `${task.title} / ${task.claimedBy}`);
  }

  // 完成回填时间与说明
  function completeTask(id: string, note: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task || task.status !== "进行中" || task.completedAt) return;
    task.completedAt = now();
    task.completionNote = (note || "").trim();
    task.status = "已完成";
    task.deviceUpdatedAt = now();
    upsertLocalReceipt(task, { completedAt: task.completedAt, completionNote: task.completionNote });
    recalcHouseholdStatus(task.householdId);
    enqueue("任务", "完成", `${task.title} / ${task.claimedBy}`);
  }

  // 中心撤销：没领取的作废，已领取的退回待接收
  function revokeTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    if (task.status === "待接收") {
      task.status = "已撤销";
      task.revokedAt = now();
      enqueue("任务", "撤销作废", task.title);
    } else if (task.status === "进行中") {
      task.status = "待接收";
      task.claimedBy = "";
      task.claimedAt = null;
      task.arrivedAt = null;
      task.arrivalNote = "";
      task.completedAt = null;
      task.completionNote = "";
      task.revokedAt = null;
      task.receiptResetAt = now(); // 标记新周期开始，旧回执不再回填本任务
      enqueue("任务", "撤销退回", task.title);
    } else {
      return;
    }
    task.version += 1;
    task.deviceUpdatedAt = now();
    recalcHouseholdStatus(task.householdId);
  }

  // 本机未上传的回执草稿：同一任务在本机只保留一条，到场/完成往里累加
  function upsertLocalReceipt(task: FieldTask, patch: Partial<Receipt>) {
    const after = task.receiptResetAt ? new Date(task.receiptResetAt).getTime() : 0;
    let receipt = receipts.value.find((item) => item.taskId === task.id && !item.uploadedAt && new Date(item.createdAt).getTime() >= after);
    if (!receipt) {
      receipt = {
        id: crypto.randomUUID(),
        taskId: task.id,
        householdId: task.householdId,
        group: task.claimedBy || task.assignee,
        claimedAt: task.claimedAt,
        arrivedAt: task.arrivedAt,
        arrivalNote: task.arrivalNote,
        completedAt: task.completedAt,
        completionNote: task.completionNote,
        deviceId: "local",
        uploadedAt: null,
        createdAt: now()
      };
      receipts.value.push(receipt);
    }
    Object.assign(receipt, patch);
  }

  // 同一任务的重复回执合并：首次到场（时间最早）、末次完成（时间最晚）
  function mergeReceiptsForTask(taskId: string, scoped?: Receipt[]): Receipt | null {
    const list = scoped ?? receipts.value.filter((item) => item.taskId === taskId);
    if (!list.length) return null;
    const byAsc = (key: "claimedAt" | "arrivedAt" | "completedAt") =>
      list.filter((item) => item[key]).sort((a, b) => +new Date(a[key]!) - +new Date(b[key]!));
    const earliestClaim = byAsc("claimedAt")[0];
    const earliestArrival = byAsc("arrivedAt")[0];
    const latestCompletion = byAsc("completedAt").pop();
    return {
      id: earliestClaim?.id ?? list[0].id,
      taskId,
      householdId: list[0].householdId,
      group: earliestClaim?.group ?? list[0].group,
      claimedAt: earliestClaim?.claimedAt ?? null,
      arrivedAt: earliestArrival?.arrivedAt ?? null,
      arrivalNote: earliestArrival?.arrivalNote ?? "",
      completedAt: latestCompletion?.completedAt ?? null,
      completionNote: latestCompletion?.completionNote ?? "",
      deviceId: "merged",
      uploadedAt: now(),
      createdAt: list[0].createdAt
    };
  }

  // 用合并后的回执回填任务当前状态
  function applyReceiptToTask(taskId: string) {
    const task = tasks.value.find((item) => item.id === taskId);
    if (!task || task.status === "已撤销") return;
    const after = task.receiptResetAt ? new Date(task.receiptResetAt).getTime() : 0;
    const scoped = receipts.value.filter((item) => item.taskId === taskId && new Date(item.createdAt).getTime() >= after);
    if (!scoped.length) return;
    const merged = mergeReceiptsForTask(taskId, scoped);
    if (!merged) return;
    task.claimedBy = merged.group || task.claimedBy;
    task.claimedAt = merged.claimedAt;
    task.arrivedAt = merged.arrivedAt;
    task.arrivalNote = merged.arrivalNote;
    task.completedAt = merged.completedAt;
    task.completionNote = merged.completionNote;
    if (merged.completedAt) task.status = "已完成";
    else if (merged.arrivedAt || merged.claimedAt) task.status = "进行中";
    else task.status = "待接收";
    task.deviceUpdatedAt = now();
    recalcHouseholdStatus(task.householdId);
  }

  function simulateSync() {
    syncing.value = true;
    setTimeout(() => {
      // 1. 上传本机未回执的草稿
      receipts.value.forEach((receipt) => {
        if (!receipt.uploadedAt) receipt.uploadedAt = now();
      });
      // 2. 拉取远端：同一任务可能被重复上传（如另一台设备），到场更早、完成更晚。
      //    仅针对当前周期内已领取/已完成的任务；待接收（含撤销退回）的任务没有当前周期的到场/完成可合并。
      const targets = tasks.value.filter((task) => task.status === "进行中" || task.status === "已完成");
      targets.forEach((task) => {
        if (receipts.value.some((receipt) => receipt.taskId === task.id && receipt.deviceId === "remote-other")) return;
        const after = task.receiptResetAt ? new Date(task.receiptResetAt).getTime() : 0;
        const local = receipts.value.find((receipt) => receipt.taskId === task.id && new Date(receipt.createdAt).getTime() >= after);
        if (!local) return;
        const dupArrival = local.arrivedAt ? new Date(new Date(local.arrivedAt).getTime() - 6 * 60000).toISOString() : null;
        const dupCompletion = local.completedAt ? new Date(new Date(local.completedAt).getTime() + 8 * 60000).toISOString() : null;
        if (!dupArrival && !dupCompletion) return;
        receipts.value.push({
          id: crypto.randomUUID(),
          taskId: task.id,
          householdId: task.householdId,
          group: "邻组支援",
          claimedAt: local.claimedAt,
          arrivedAt: dupArrival,
          arrivalNote: dupArrival ? "邻组先期到场确认位置" : "",
          completedAt: dupCompletion,
          completionNote: dupCompletion ? "邻组收尾复核完成" : "",
          deviceId: "remote-other",
          uploadedAt: now(),
          createdAt: now()
        });
      });
      // 3. 按任务合并回执并回填（首次到场、末次完成），再重算家庭状态
      const taskIds = [...new Set(receipts.value.map((receipt) => receipt.taskId))];
      taskIds.forEach(applyReceiptToTask);
      // 4. 家庭字段级冲突演示
      const first = households.value[0];
      if (first) conflicts.value.unshift({ id: crypto.randomUUID(), householdId: first.id, field: "address", localValue: first.address, remoteValue: "河湾路18号2栋2单元", status: "待处理" });
      lastSyncedAt.value = now();
      queue.value = [];
      syncing.value = false;
    }, 650);
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict) return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") (household as unknown as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
    conflict.status = resolution;
    if (household) household.version += 1;
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, receipts, queue, conflicts, lastSyncedAt], () => {
      localStorage.setItem(KEY, JSON.stringify({ households: households.value, tasks: tasks.value, receipts: receipts.value, queue: queue.value, conflicts: conflicts.value, lastSyncedAt: lastSyncedAt.value }));
    }, { deep: true });
  }

  return { households, tasks, receipts, queue, conflicts, online, lastSyncedAt, syncing, metrics, duplicates, addHousehold, updateHousehold, mergeDuplicate, addTask, claimTask, arriveTask, completeTask, revokeTask, simulateSync, resolveConflict, enqueue };
});
