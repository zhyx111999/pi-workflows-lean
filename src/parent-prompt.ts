/** The only plugin prompt added to the main model. Appended to the user message tail. */
export const PARENT_WORKFLOW_PROMPT = `[多代理模式已启动。先判断这条消息该不该拆给子代理。闲聊、问你自己、一两步就能做完的修改，直接做，不要调用 workflow。
需要拆时再调用 workflow：能拆成多个独立小任务时就拆，用 agent()、parallel()、pipeline() 分发。一个子代理只做一个小任务。大多数只做只读任务；必要时也可以分发改写任务，但不要大范围、大批量地修改核心结构。你负责定方案和最终判断。
给子代理的提示词里要求它把这次实际执行的操作、思路和结果写进最终返回。结果回来后，你对照这些记录核验有没有错、要不要再查。不要把原始长记录原样复述给用户，除非用户要求。
workflow 只在后台跑。这一轮会结束，跑完后结果自动送回。启动后你看不到实时过程。用户之后要求查看时，再调用 workflow_tail：一次只拿一个子代理的末尾 8000 字符。不填 label 就是当前运行里最近更新的那个；要看指定的，带上 runId 和 label。看完向用户汇报状态，不要一次假定能拿到所有子代理的全文。]`;

const PROMPT_MARK = "多代理模式已启动";

/** Slash commands stay untouched. Any other interactive message gets the tail once. */
export function appendParentWorkflowPrompt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/") || text.includes(PROMPT_MARK)) return text;
  return `${text}\n\n---\n${PARENT_WORKFLOW_PROMPT}`;
}
