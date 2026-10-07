<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NModal, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type Household, type NeedLevel, type TaskStatus } from "~/stores/assessment";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.string().min(1, "请输入家庭人数"), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: "1", needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");
const claimGroup = ref("救援一组");
const noteModal = ref<{ show: boolean; taskId: string; kind: "arrive" | "complete"; text: string }>({ show: false, taskId: "", kind: "arrive", text: "" });

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members) || 1, vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
function openNote(taskId: string, kind: "arrive" | "complete") {
  noteModal.value = { show: true, taskId, kind, text: "" };
}
function submitNote() {
  const task = store.tasks.find((item) => item.id === noteModal.value.taskId);
  if (!task) return;
  if (noteModal.value.kind === "arrive") store.arriveTask(task.id, noteModal.value.text);
  else store.completeTask(task.id, noteModal.value.text);
  noteModal.value.show = false;
}
function sync() {
  if (!store.online) { syncMessage.value = "仍在弱网状态，队列保留在设备中。"; return; }
  syncMessage.value = "正在人工合并离线变更…";
  store.simulateSync();
  setTimeout(() => { syncMessage.value = "同步完成：回执已按首次到场、末次完成合并，家庭状态已重算，另发现 1 个字段冲突待处理。"; }, 800);
}
function householdName(id: string) {
  return store.households.find((item) => item.id === id)?.head ?? "—";
}
function openCount(householdId: string) {
  return store.tasks.filter((item) => item.householdId === householdId && (item.status === "待接收" || item.status === "进行中")).length;
}
function fmtTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function statusType(status: TaskStatus) {
  if (status === "已完成") return "success";
  if (status === "进行中") return "warning";
  if (status === "已撤销") return "default";
  return "info";
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>记录可离线保存，恢复连接后必须人工确认字段冲突。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.queue.length * 8" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录与任务仍可操作，所有变更会写入IndexedDB兼容的本地缓存与待同步队列。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><small>{{ item.status }} · v{{ item.version }}</small><NTag v-if="openCount(item.id)" type="warning" size="small" style="margin-top:4px">未完成 {{ openCount(item.id) }} 项</NTag></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="members" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div></form></NCard>
      </div>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并为一条并保留需求并集</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>
      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="派工与执行回执"><div v-for="task in store.tasks" :key="task.id" class="task-card"><div class="task-head"><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><NTag>{{ task.priority }}</NTag><NTag :type="statusType(task.status)">{{ task.status }}</NTag></div><small>{{ householdName(task.householdId) }} · {{ task.due }} · 指派 {{ task.assignee }}</small><div class="receipt-grid"><div><small>领取小组</small><b>{{ task.claimedBy || '未领取' }}</b></div><div><small>到场时间</small><b>{{ fmtTime(task.arrivedAt) }}</b></div><div><small>到场说明</small><span>{{ task.arrivalNote || '—' }}</span></div><div><small>完成时间</small><b>{{ fmtTime(task.completedAt) }}</b></div><div><small>完成说明</small><span>{{ task.completionNote || '—' }}</span></div></div><div class="actions"><template v-if="task.status === '待接收'"><NInput v-model:value="claimGroup" size="small" placeholder="领取小组" style="max-width:160px" /><NButton size="small" type="primary" @click="store.claimTask(task.id, claimGroup)">离线领取</NButton><NButton size="small" @click="store.revokeTask(task.id)">撤销</NButton></template><template v-else-if="task.status === '进行中'"><NButton size="small" :disabled="!!task.arrivedAt" @click="openNote(task.id, 'arrive')">回填到场</NButton><NButton size="small" type="primary" :disabled="!task.arrivedAt || !!task.completedAt" @click="openNote(task.id, 'complete')">回填完成</NButton><NButton size="small" @click="store.revokeTask(task.id)">撤销</NButton></template><template v-else><NTag :type="task.status === '已撤销' ? 'default' : 'success'">{{ task.status === '已撤销' ? '已作废' : '已闭环' }}</NTag></template></div></div><p v-if="!store.tasks.length" class="empty">暂无派工任务。</p></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>指派小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton><p class="tip">分派后为待接收；队员离线领取时记下实际小组，到场与完成分别回填时间和说明。</p></NCard></div>
      <NCard v-if="panel === '同步队列'" title="待同步操作"><p>{{ syncMessage || '恢复连接后按顺序提交，冲突不会自动覆盖。' }}</p><div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag>{{ item.action }}</NTag><span>{{ item.entity }} · {{ item.detail }}</span><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div><p v-if="!store.queue.length" class="empty">待同步队列为空。</p><NButton type="primary" :loading="store.syncing" @click="sync">人工确认并同步</NButton><small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small></NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突"><div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ item.field }}</b><div class="conflict-values"><div><small>本机记录</small><span>{{ item.localValue }}</span></div><div><small>远端记录</small><span>{{ item.remoteValue }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton><NTag>{{ item.status }}</NTag></div></div><p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先点击“人工确认并同步”模拟多人合并。</p></NCard>
    </main>
    <NModal v-model:show="noteModal.show" preset="card" :title="noteModal.kind === 'arrive' ? '回填到场信息' : '回填完成信息'" style="max-width:420px">
      <NInput v-model:value="noteModal.text" type="textarea" :placeholder="noteModal.kind === 'arrive' ? '到场情况说明，如位置、现场情况' : '完成情况说明，如交付情况、后续建议'" />
      <template #footer>
        <NButton @click="noteModal.show = false">取消</NButton>
        <NButton type="primary" @click="submitNote">确认回填</NButton>
      </template>
    </NModal>
  </div>
</template>
