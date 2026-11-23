import type { ChannelLocale } from './transport.ts';

const channelStrings = {
  'zh-TW': {
    empty: '請輸入文字訊息。',
    askUsage: '請輸入 /ask 知識庫ID 問題',
    askUnavailable: '沒有可核對的知識答案。請確認知識庫及模型授權。',
    externalAttachment: (name: string) => `請在 OEP 工作台傳送附件「${name}」，以便檢查其資料分級。`,
    externalConfirm: '請在五分鐘內輸入 /confirm，確認將這則訊息傳送給外部幫手。',
    externalNoConfirmation: '沒有等待確認的外部幫手訊息。',
    externalIssue: (_code: string, _name: string, text: string) => text,
    citation: (quote: string, reference: string) => `「${quote}」\n來源 ${reference}`,
    cancelled: '對話已停止。',
    failed: '對話未完成，請在工作台確認服務狀態。',
    completed: '對話已完成。',
    deadline: (id: number) => `更新 ${id} 未能在期限內處理。已保留原始收件，請在工作台核對後再試。`,
    published: 'BI 審核已發布。請在工作台查看版本。',
    delegationAccepted: (name: string, id: string) => `已交辦給${name}（${id}）。`,
    delegationResult: (name: string, id: string, status: string, summary: string) =>
      `${name}的交辦（${id}）${status}。${summary ? '\n' + summary : ''}\n請在工作台查看執行紀錄。`,
    delegationStatuses: {
      succeeded: '已完成', needs_input: '待補件', failed: '失敗', timed_out: '已逾時', cancelled: '已取消',
      indeterminate: '待核對', submitted: '已送審',
    },
    status: (jobs: number, complete: number) => `BI 工作共 ${jobs} 筆，已送審 ${complete} 筆。`,
    review: (id: number) => `收件 ${id} 已送審。`,
    blocked: (id: number) => `收件 ${id} 需要補件，請開啟工作台。`,
    ready: (id: number) => `收件 ${id} 正在處理。`,
    sourceUnavailable: '這個對話無法存取該收件。',
    supplementUsage: '請輸入 /supplement 收件ID 補件文字',
    ownerAction: '請在工作台核准、拒絕或發布審核。',
    replyInstruction: '請以繁體中文回覆使用者。',
  },
  en: {
    empty: 'Enter a text message.',
    askUsage: 'Enter /ask vaultID question',
    askUnavailable: 'No verifiable answer is available. Check the vault and model permissions.',
    externalAttachment: (name: string) => `Send “${name}” from the OEP workbench so it can check the attachment’s classification.`,
    externalConfirm: 'Enter /confirm within five minutes to send this message to the external helper.',
    externalNoConfirmation: 'No external helper message is waiting for confirmation.',
    externalIssue: (code: string, name: string, _text: string) => {
      switch (code) {
        case 'external-confidential-item': return `“${name}” contains confidential data and cannot be sent to an external helper.`;
        case 'external-unclassified-item': return `Strict mode requires “${name}” to be marked public.`;
        case 'external-changed-item': return `“${name}” changed. Review it before sending again.`;
        case 'external-isolation-unavailable': return 'Windows helper isolation is unverified. Check OEP Settings → External Helpers.';
        case 'external-cli-login-unavailable': return 'Sign in to this provider in OEP Settings → External Helpers.';
        case 'external-disabled': return 'Enable this provider in OEP Settings → External Helpers.';
        default: return 'The external helper could not complete the message. Check OEP for details.';
      }
    },
    citation: (quote: string, reference: string) => `“${quote}”\nSource ${reference}`,
    cancelled: 'The conversation was stopped.',
    failed: 'The conversation did not finish. Check the workbench for its status.',
    completed: 'The conversation is complete.',
    deadline: (id: number) => `Update ${id} reached its processing deadline. The original intake was saved. Check the workbench before trying again.`,
    published: 'The BI review was published. Open the workbench to view the version.',
    delegationAccepted: (name: string, id: string) => `Delegated to ${name} (${id}).`,
    delegationResult: (name: string, id: string, status: string, summary: string) =>
      `${name}’s delegation (${id}) ${status}.${summary ? '\n' + summary : ''}\nOpen the workbench to view the run record.`,
    delegationStatuses: {
      succeeded: 'succeeded', needs_input: 'needs input', failed: 'failed', timed_out: 'timed out', cancelled: 'was cancelled',
      indeterminate: 'needs verification', submitted: 'was submitted for review',
    },
    status: (jobs: number, complete: number) => `BI jobs: ${jobs} total, ${complete} submitted for review.`,
    review: (id: number) => `Intake ${id} was submitted for review.`,
    blocked: (id: number) => `Intake ${id} needs additional information. Open the workbench.`,
    ready: (id: number) => `Intake ${id} is being processed.`,
    sourceUnavailable: 'This intake is unavailable in this conversation.',
    supplementUsage: 'Enter /supplement intakeID additional text',
    ownerAction: 'Use the workbench to approve, reject, or publish reviews.',
    replyInstruction: 'Reply to the user in English.',
  },
};

export const channelText = (locale: ChannelLocale = 'zh-TW') => channelStrings[locale];

export function intakeStatus(locale: ChannelLocale, id: number, state: string | undefined) {
  const messages = channelText(locale);
  switch (state) {
    case 'awaiting_review': return messages.review(id);
    case 'blocked': return messages.blocked(id);
    case 'ready': return messages.ready(id);
    default: return messages.sourceUnavailable;
  }
}
