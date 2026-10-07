import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成" | "已作废";

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

/** 执行回执：一次“领取-到场-完成”闭环的回填信息 */
export interface TaskReceipt {
  /** 离线领取时记下的小组 */
  team: string;
  claimedAt: string | null;
  /** 到场时间与现场说明（只认首次到场） */
  arrivedAt: string | null;
  arrivalNote: string;
  /** 完成时间与完工说明（只认末次完成） */
  completedAt: string | null;
  completionNote: string;
  updatedAt: string | null;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
  receipt: TaskReceipt;
  /** 中心撤销退回待接收时，已产生的旧回执归档在此，保留“谁到场过”的凭据 */
  history: TaskReceipt[];
  version: number;
  updatedAt: string;
}

/** 结构化待同步操作：断网期间入队，联网后按操作幂等重放合并 */
export interface PendingOp {
  id: string;
  entity: "家庭需求记录" | "派工任务";
  action: "新增" | "修改" | "合并" | "分派" | "领取" | "到场" | "完成";
  entityId: string;
  detail: string;
  payload: Record<string, unknown> | null;
  deviceId: string;
  offline: boolean;
  time: string;
}

export interface CenterCancel {
  taskId: string;
  at: string;
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
const DEVICE_KEY = "pair-wise-yf-50/deviceId";

const TASK_RECEIPT_ACTIONS: PendingOp["action"][] = ["领取", "到场", "完成"];

export function emptyReceipt(): TaskReceipt {
  return { team: "", claimedAt: null, arrivedAt: null, arrivalNote: "", completedAt: null, completionNote: "", updatedAt: null };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 回执合并：同一条任务多台设备/重复上传时
 * 领取先到先得，到场只认最早一次，完成只认最晚一次。
 * 返回 null 表示本次上报没有产生变化（重复数据）。
 */
export function mergeReceipt(
  receipt: TaskReceipt,
  op: { action: string; time: string; payload: Record<string, unknown> | null }
): TaskReceipt | null {
  const payload = op.payload ?? {};
  if (op.action === "领取") {
    if (receipt.claimedAt) return null;
    return { ...receipt, team: String(payload.team ?? receipt.team ?? ""), claimedAt: op.time, updatedAt: op.time };
  }
  if (op.action === "到场") {
    if (receipt.arrivedAt && receipt.arrivedAt <= op.time) return null;
    return {
      ...receipt,
      team: receipt.team || String(payload.team ?? ""),
      arrivedAt: op.time,
      arrivalNote: String(payload.note ?? ""),
      updatedAt: op.time
    };
  }
  if (op.action === "完成") {
    if (receipt.completedAt && receipt.completedAt >= op.time) return null;
    return { ...receipt, completedAt: op.time, completionNote: String(payload.note ?? ""), updatedAt: op.time };
  }
  return null;
}

/**
 * 家庭状态随派工任务重算：
 * 有待接收/进行中的任务 -> 已分派；任务全部完成 -> 已完成；
 * 任务均作废/无任务 -> 退回待复核（评估状态不被任务覆盖）。
 */
export function recomputeHouseholdStatus(household: Household, related: FieldTask[]): HouseholdStatus {
  const active = related.some((task) => task.status === "待接收" || task.status === "进行中");
  if (active) return "已分派";
  const done = related.some((task) => task.status === "已完成");
  if (done) return "已完成";
  if (household.status === "已分派" || household.status === "已完成") return "待复核";
  return household.status;
}

function normalizeTask(raw: Record<string, unknown>): FieldTask {
  const receipt = (raw.receipt as TaskReceipt) ?? emptyReceipt();
  return {
    id: String(raw.id),
    householdId: String(raw.householdId),
    title: String(raw.title),
    assignee: String(raw.assignee ?? ""),
    priority: (raw.priority as NeedLevel) ?? "一般",
    status: (raw.status as TaskStatus) ?? "待接收",
    due: String(raw.due ?? ""),
    receipt: { ...emptyReceipt(), ...receipt },
    history: Array.isArray(raw.history) ? (raw.history as TaskReceipt[]) : [],
    version: Number(raw.version ?? 1),
    updatedAt: String(raw.updatedAt ?? nowIso())
  };
}

function normalizeOp(raw: Record<string, unknown>): PendingOp {
  return {
    id: String(raw.id),
    entity: (raw.entity as PendingOp["entity"]) ?? "派工任务",
    action: (raw.action as PendingOp["action"]) ?? "修改",
    entityId: String(raw.entityId ?? ""),
    detail: String(raw.detail ?? ""),
    payload: (raw.payload as Record<string, unknown>) ?? null,
    deviceId: String(raw.deviceId ?? "unknown"),
    offline: Boolean(raw.offline),
    time: String(raw.time ?? nowIso())
  };
}

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];

const claimedAt = new Date(Date.now() - 40 * 60000).toISOString();
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-10-08 12:00", receipt: { ...emptyReceipt(), team: "后勤二组", claimedAt, updatedAt: claimedAt }, history: [], version: 1, updatedAt: claimedAt },
  { id: "k2", householdId: "h1", title: "临时安置转移对接", assignee: "救援一组", priority: "紧急", status: "待接收", due: "2026-10-08 09:00", receipt: emptyReceipt(), history: [], version: 1, updatedAt: new Date().toISOString() }
];

export const useAssessmentStore = defineStore("assessment", () => {
  const stored = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;

  const deviceId = (() => {
    if (typeof window === "undefined") return "SSR";
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id = `DEV-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  })();

  const households = ref<Household[]>(stored?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>((stored?.tasks ?? seedTasks).map((item: Record<string, unknown>) => normalizeTask(item)));
  const queue = ref<PendingOp[]>((stored?.queue ?? []).map((item: Record<string, unknown>) => normalizeOp(item)));
  const conflicts = ref<FieldConflict[]>(stored?.conflicts ?? []);
  const centerCancels = ref<CenterCancel[]>(stored?.centerCancels ?? []);
  /** 服务端已受理的操作 id：同一操作重复上传直接忽略（幂等） */
  const appliedOpIds = ref<string[]>(stored?.appliedOpIds ?? []);
  /** 最近受理过的操作留底，用于模拟“同一回执再次上传” */
  const opLog = ref<PendingOp[]>((stored?.opLog ?? []).map((item: Record<string, unknown>) => normalizeOp(item)));
  const online = ref(true);
  const lastSyncedAt = ref(stored?.lastSyncedAt ?? nowIso());
  const syncing = ref(false);
  const syncSummary = ref("");

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status === "待接收" || item.status === "进行中").length,
    voided: tasks.value.filter((item) => item.status === "已作废").length,
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

  function enqueueOp(op: PendingOp) {
    if (queue.value.some((item) => item.id === op.id)) return;
    queue.value.unshift(op);
  }

  function logChange(
    entity: PendingOp["entity"],
    action: PendingOp["action"],
    entityId: string,
    detail: string,
    payload: Record<string, unknown> | null = null,
    fromDevice = deviceId
  ): PendingOp {
    const op: PendingOp = { id: crypto.randomUUID(), entity, action, entityId, detail, payload, deviceId: fromDevice, offline: !online.value, time: nowIso() };
    enqueueOp(op);
    return op;
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    households.value.unshift({ ...input, id: crypto.randomUUID(), status: "待评估", version: 1, deviceUpdatedAt: nowIso() });
    logChange("家庭需求记录", "新增", "", input.head);
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: nowIso() });
    logChange("家庭需求记录", "修改", id, `${household.head}：${Object.keys(patch).join("、")}`);
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    target.needs = Array.from(new Set([...target.needs, ...source.needs]));
    target.vulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    target.note = `${target.note}；已合并重复记录 ${source.address}`;
    target.version += 1;
    households.value = households.value.filter((item) => item.id !== sourceId);
    logChange("家庭需求记录", "合并", targetId, `${source.head} → ${target.address}`);
  }

  function addTask(input: Omit<FieldTask, "id" | "status" | "receipt" | "history" | "version" | "updatedAt">) {
    const task: FieldTask = {
      ...input,
      id: crypto.randomUUID(),
      status: "待接收",
      receipt: emptyReceipt(),
      history: [],
      version: 1,
      updatedAt: nowIso()
    };
    tasks.value.unshift(task);
    logChange("派工任务", "分派", task.id, `${input.title} / ${input.assignee}`);
    recomputeHousehold(task.householdId);
  }

  function findTask(id: string) {
    return tasks.value.find((item) => item.id === id);
  }

  /** 本地立即应用一条回执操作（乐观执行），联网后同一操作幂等重放 */
  function applyTaskOp(task: FieldTask, op: PendingOp): boolean {
    const merged = mergeReceipt(task.receipt, op);
    if (!merged) return false;
    task.receipt = merged;
    if (task.status !== "已作废") {
      if (task.receipt.completedAt) task.status = "已完成";
      else if (task.receipt.claimedAt) task.status = "进行中";
    }
    task.version += 1;
    task.updatedAt = nowIso();
    return true;
  }

  /** 离线领取：记下领取小组 */
  function claimTask(id: string, team: string) {
    const task = findTask(id);
    const name = team.trim() || task?.assignee;
    if (!task || !name || task.status !== "待接收" || task.receipt.claimedAt) return;
    const op = logChange("派工任务", "领取", id, `${name} 领取任务`, { team: name });
    applyTaskOp(task, op);
    recomputeHousehold(task.householdId);
  }

  /** 到场回填时间与说明 */
  function markArrived(id: string, note: string) {
    const task = findTask(id);
    if (!task || task.status === "已作废" || !task.receipt.claimedAt || task.receipt.arrivedAt) return;
    const op = logChange("派工任务", "到场", id, `${task.receipt.team} 到场回填`, { note: note.trim() });
    applyTaskOp(task, op);
  }

  /** 完成回填时间与说明 */
  function markCompleted(id: string, note: string) {
    const task = findTask(id);
    if (!task || task.status === "已作废" || !task.receipt.arrivedAt || task.receipt.completedAt) return;
    const op = logChange("派工任务", "完成", id, `${task.receipt.team} 完成回填`, { note: note.trim() });
    applyTaskOp(task, op);
    recomputeHousehold(task.householdId);
  }

  function taskStats(householdId: string) {
    const related = tasks.value.filter((item) => item.householdId === householdId);
    return {
      active: related.filter((item) => item.status === "待接收" || item.status === "进行中").length,
      done: related.filter((item) => item.status === "已完成").length,
      voided: related.filter((item) => item.status === "已作废").length
    };
  }

  function recomputeHousehold(householdId: string) {
    const household = households.value.find((item) => item.id === householdId);
    if (!household) return;
    household.status = recomputeHouseholdStatus(household, tasks.value.filter((item) => item.householdId === householdId));
  }

  /** 中心撤销登记：联网同步拉取时生效。未领取作废，已领取退回待接收 */
  function requestCenterCancel(id: string) {
    const task = findTask(id);
    if (!task || task.status === "已作废" || centerCancels.value.some((item) => item.taskId === id)) return;
    centerCancels.value.unshift({ taskId: id, at: nowIso() });
  }

  function applyCenterCancel(task: FieldTask): "作废" | "退回待接收" | "忽略" {
    if (task.status === "已作废") return "忽略";
    if (task.status === "待接收" && !task.receipt.claimedAt) {
      // 没人领取：直接作废
      task.status = "已作废";
      task.version += 1;
      task.updatedAt = nowIso();
      return "作废";
    }
    // 已领取（进行中/已到场/已完成）：旧回执归档留底，任务退回待接收等待重新接收
    if (task.receipt.claimedAt) task.history.unshift({ ...task.receipt });
    task.receipt = emptyReceipt();
    task.status = "待接收";
    task.version += 1;
    task.updatedAt = nowIso();
    return "退回待接收";
  }

  function simulateSync(): "offline" | "done" {
    if (!online.value || syncing.value) return "offline";
    syncing.value = true;
    setTimeout(() => {
      const notes: string[] = [];
      let ignored = 0;
      let mergedCount = 0;
      let voided = 0;
      let returned = 0;

      // 按时间顺序重放队列；同一操作 id 已受理过则忽略（断网重试导致的重复上传）
      const chronological = [...queue.value].reverse();
      for (const op of chronological) {
        if (appliedOpIds.value.includes(op.id)) {
          ignored += 1;
          continue;
        }
        appliedOpIds.value.unshift(op.id);
        opLog.value.unshift(op);
        if (op.entity === "派工任务" && TASK_RECEIPT_ACTIONS.includes(op.action)) {
          const task = findTask(op.entityId);
          if (task && applyTaskOp(task, op)) mergedCount += 1;
        }
      }
      if (appliedOpIds.value.length > 500) appliedOpIds.value = appliedOpIds.value.slice(0, 500);
      if (opLog.value.length > 200) opLog.value = opLog.value.slice(0, 200);

      // 拉取中心撤销指令
      for (const cancel of centerCancels.value) {
        const task = findTask(cancel.taskId);
        if (!task) continue;
        const result = applyCenterCancel(task);
        if (result === "作废") voided += 1;
        if (result === "退回待接收") returned += 1;
      }
      centerCancels.value = [];

      // 任务状态更新后，家庭状态统一重算
      new Set(tasks.value.map((task) => task.householdId)).forEach((id) => recomputeHousehold(id));

      // 演示字段级冲突（每条记录只造一次）
      const first = households.value[0];
      if (first && !conflicts.value.some((item) => item.householdId === first.id && item.field === "address")) {
        conflicts.value.unshift({ id: crypto.randomUUID(), householdId: first.id, field: "address", localValue: first.address, remoteValue: "河湾路18号2栋2单元", status: "待处理" });
        notes.push("发现 1 个字段冲突待人工处理");
      }

      if (mergedCount) notes.push(`回执合并 ${mergedCount} 条（到场取最早、完成取最晚）`);
      if (ignored) notes.push(`重复上传忽略 ${ignored} 条`);
      if (voided) notes.push(`未领取任务作废 ${voided} 条`);
      if (returned) notes.push(`已领取任务退回待接收 ${returned} 条`);
      if (!notes.length) notes.push("无新增变更，本地与中心一致");

      lastSyncedAt.value = nowIso();
      queue.value = [];
      syncing.value = false;
      syncSummary.value = `同步合并完成：${notes.join("；")}。`;
    }, 600);
    return "done";
  }

  /** 演示队友设备对同一任务重复上报：更早的到场、更晚的完成，外加一条同 id 重传 */
  function simulateDuplicateUpload(): string {
    const target = tasks.value.find((item) => item.id === "k1") ?? tasks.value[0];
    if (!target) return "暂无任务可模拟。";
    const added: string[] = [];

    // 同一操作原封不动重传一次，服务端按 op id 去重
    const previous = opLog.value.find((op) => op.entityId === target.id && op.action === "到场");
    if (previous) {
      enqueueOp({ ...previous });
      added.push("1 条相同回执重传（将被忽略）");
    }

    const arriveBase = target.receipt.arrivedAt ? Date.parse(target.receipt.arrivedAt) : Date.now();
    enqueueOp({
      id: crypto.randomUUID(),
      entity: "派工任务",
      action: "到场",
      entityId: target.id,
      detail: "队友设备补传：更早的到场",
      payload: { note: "队友设备补传：先行到场，接应老人转移" },
      deviceId: "TEAM-02",
      offline: false,
      time: new Date(arriveBase - 20 * 60000).toISOString()
    });
    added.push("1 条更早到场时间");

    if (target.receipt.completedAt) {
      enqueueOp({
        id: crypto.randomUUID(),
        entity: "派工任务",
        action: "完成",
        entityId: target.id,
        detail: "队友设备补传：更晚的完成",
        payload: { note: "队友设备补传：最终交接清点完毕", },
        deviceId: "TEAM-02",
        offline: false,
        time: new Date(Date.parse(target.receipt.completedAt) + 20 * 60000).toISOString()
      });
      added.push("1 条更晚完成时间");
    }

    return `已为「${target.title}」插入${added.join("、")}，联网同步后按首次到场、末次完成合并。`;
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict) return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (household && resolution === "采用远端") (household as unknown as Record<string, unknown>)[conflict.field] = conflict.remoteValue;
    conflict.status = resolution;
    if (household) household.version += 1;
  }

  // 初次加载也按任务状态重算家庭，避免历史缓存里状态不一致
  tasks.value.forEach((task) => recomputeHousehold(task.householdId));

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, conflicts, centerCancels, appliedOpIds, opLog, lastSyncedAt], () => {
      localStorage.setItem(KEY, JSON.stringify({
        households: households.value,
        tasks: tasks.value,
        queue: queue.value,
        conflicts: conflicts.value,
        centerCancels: centerCancels.value,
        appliedOpIds: appliedOpIds.value,
        opLog: opLog.value,
        lastSyncedAt: lastSyncedAt.value
      }));
    }, { deep: true });
  }

  return {
    deviceId,
    households,
    tasks,
    queue,
    conflicts,
    centerCancels,
    opLog,
    online,
    lastSyncedAt,
    syncing,
    syncSummary,
    metrics,
    duplicates,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    claimTask,
    markArrived,
    markCompleted,
    taskStats,
    requestCenterCancel,
    simulateSync,
    simulateDuplicateUpload,
    resolveConflict
  };
});
