<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type NeedLevel } from "~/stores/assessment";

const store = useAssessmentStore();
const browserOnline = ref(true);
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
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

const update = () => { browserOnline.value = navigator.onLine; };
onMounted(() => {
  browserOnline.value = navigator.onLine;
  store.online = navigator.onLine;
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
});
onBeforeUnmount(() => {
  window.removeEventListener("online", update);
  window.removeEventListener("offline", update);
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-10-08 18:00" });
}
function sync() {
  if (!store.online) { syncMessage.value = "仍在弱网状态，队列保留在设备中。"; return; }
  syncMessage.value = "正在联网合并离线变更…";
  const result = store.simulateSync();
  if (result === "offline") return;
  setTimeout(() => { syncMessage.value = store.syncSummary; }, 750);
}
function simulateDupes() {
  syncMessage.value = store.simulateDuplicateUpload();
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>本机 {{ store.deviceId }}</small><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-10-07 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>需求记录—派工任务—执行回执全链路离线可填，联网后幂等合并，冲突不静默覆盖。</p></div><div class="status-chip"><NProgress type="circle" :percentage="store.queue.length ? Math.max(12, 100 - store.queue.length * 8) : 100" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="进行中任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。领取、到场、完成回填照常操作，全部写入本地待同步队列，联网后按“首次到场、末次完成”合并。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p><small class="task-count">任务：进行中 {{ store.taskStats(item.id).active }} / 已完成 {{ store.taskStats(item.id).done }}<template v-if="store.taskStats(item.id).voided"> / 已作废 {{ store.taskStats(item.id).voided }}</template></small></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="members" type="number" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div></form></NCard>
      </div>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并为一条并保留需求并集</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>
      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="派工任务与执行回执"><TaskItemClient v-for="task in store.tasks" :key="task.id" :task="task" /><p v-if="!store.tasks.length" class="empty">暂无任务。</p></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b>（状态：{{ selected?.status }}）</p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton><p class="hint">任务分派后家庭状态自动变为「已分派」；只有关联任务全部完成，家庭才会变为「已完成」。</p></NCard></div>
      <NCard v-if="panel === '同步队列'" title="待同步操作"><p>{{ syncMessage || '恢复连接后按时间顺序重放：同一操作幂等去重，同一任务多次到场取最早、多次完成取最晚。' }}</p><div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag :type="item.offline ? 'warning' : 'default'">{{ item.action }}{{ item.offline ? '·离线' : '' }}</NTag><span>{{ item.entity }} · {{ item.detail }}</span><small>{{ item.deviceId }} · {{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div><p v-if="!store.queue.length" class="empty">待同步队列为空。</p><div class="actions"><NButton type="primary" :loading="store.syncing" @click="sync">联网同步合并</NButton><NButton @click="simulateDupes">模拟队友重复上传回执</NButton></div></NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突"><div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ item.field }}</b><div class="conflict-values"><div><small>本机记录</small><span>{{ item.localValue }}</span></div><div><small>远端记录</small><span>{{ item.remoteValue }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton><NTag>{{ item.status }}</NTag></div></div><p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先在「同步队列」中联网同步，模拟多人合并。</p></NCard>
    </main>
  </div>
</template>
