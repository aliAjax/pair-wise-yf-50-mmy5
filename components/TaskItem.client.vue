<script setup lang="ts">
import { computed, ref } from "vue";
import { NButton, NInput, NTag } from "naive-ui";
import { useAssessmentStore, type FieldTask, type TaskStatus } from "~/stores/assessment";
import { fmtTime } from "~/utils/format";

const props = defineProps<{ task: FieldTask }>();
const store = useAssessmentStore();

const household = computed(() => store.households.find((item) => item.id === props.task.householdId));
const cancelPending = computed(() => store.centerCancels.some((item) => item.taskId === props.task.id));
const teamInput = ref(props.task.assignee);
const arrivalNote = ref("");
const completionNote = ref("");

const statusType: Record<TaskStatus, "default" | "info" | "success" | "warning" | "error"> = {
  待接收: "info",
  进行中: "warning",
  已完成: "success",
  已作废: "error"
};
</script>

<template>
  <article class="task-card">
    <header>
      <div>
        <b :class="{ complete: task.status === '已作废' }">{{ task.title }}</b>
        <small>{{ household?.head }} 家 · 期限 {{ task.due }}</small>
      </div>
      <div class="task-tags">
        <NTag>{{ task.priority }}</NTag>
        <NTag :type="statusType[task.status]">{{ task.status }}</NTag>
      </div>
    </header>

    <div class="receipt">
      <div class="receipt-line"><span class="dot" :class="{ on: !!task.receipt.claimedAt }" /><small>领取：{{ task.receipt.claimedAt ? `${task.receipt.team} · ${fmtTime(task.receipt.claimedAt)}` : "尚未领取" }}</small></div>
      <template v-if="task.receipt.arrivedAt">
        <div class="receipt-line"><span class="dot on" /><small>到场：{{ fmtTime(task.receipt.arrivedAt) }}<template v-if="task.receipt.arrivalNote"> — {{ task.receipt.arrivalNote }}</template></small></div>
      </template>
      <template v-if="task.receipt.completedAt">
        <div class="receipt-line"><span class="dot on" /><small>完成：{{ fmtTime(task.receipt.completedAt) }}<template v-if="task.receipt.completionNote"> — {{ task.receipt.completionNote }}</template></small></div>
      </template>
      <div v-if="task.history.length" class="receipt-history">↩ 退回前的到场记录已归档 {{ task.history.length }} 份（{{ task.history.map((item) => item.team).join("、") }} 曾到场）</div>
    </div>

    <div v-if="task.status === '待接收' && !task.receipt.claimedAt" class="task-action">
      <NInput v-model:value="teamInput" size="small" placeholder="领取小组名称" />
      <NButton size="small" type="primary" @click="store.claimTask(task.id, teamInput)">离线领取（记下小组）</NButton>
    </div>
    <div v-else-if="task.status === '进行中' && !task.receipt.arrivedAt" class="task-action">
      <NInput v-model:value="arrivalNote" size="small" placeholder="到场现场说明，如：已见到户主" />
      <NButton size="small" type="primary" @click="store.markArrived(task.id, arrivalNote)">到场回填</NButton>
    </div>
    <div v-else-if="task.status === '进行中' && task.receipt.arrivedAt && !task.receipt.completedAt" class="task-action">
      <NInput v-model:value="completionNote" size="small" placeholder="完工说明，如：物资已送达并签收" />
      <NButton size="small" type="primary" @click="store.markCompleted(task.id, completionNote)">完成回填</NButton>
    </div>
    <p v-else-if="task.status === '已完成'" class="task-closed">回执已闭合；重复上报只保留首次到场与末次完成。</p>
    <p v-else-if="task.status === '已作废'" class="task-closed">中心已作废，不再执行。</p>

    <footer v-if="task.status !== '已作废'">
      <NButton size="tiny" quaternary type="error" :disabled="cancelPending" @click="store.requestCenterCancel(task.id)">
        {{ cancelPending ? "撤销指令待联网生效" : "申请中心撤销" }}
      </NButton>
    </footer>
  </article>
</template>
