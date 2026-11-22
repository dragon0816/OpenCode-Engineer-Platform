import type { ChannelLocale } from './transport.ts';

const channelStrings = {
  'zh-TW': {
    empty: '請輸入文字訊息。',
    askUsage: '請輸入 /ask 知識庫ID 問題',
    askUnavailable: '沒有可核對的知識答案。請確認知識庫及模型授權。',
    citation: (quote: string, reference: string) => `「${quote}」\n來源 ${reference}`,
    cancelled: '對話已停止。',
    failed: '對話未完成，請在工作台確認服務狀態。',
    completed: '對話已完成。',
    deadline: (id: number) => `更新 ${id} 未能在期限內處理。已保留原始收件，請在工作台核對後再試。`,
    published: 'BI 審核已發布。請在工作台查看版本。',
    status: (jobs: number, complete: number) => `BI 工作共 ${jobs} 筆，已送審 ${complete} 筆。`,
    review: (id: number) => `收件 ${id} 已送審。`,
    blocked: (id: number) => `收件 ${id} 需要補件，請開啟工作台。`,
    replyInstruction: '請以繁體中文回覆使用者。',
  },
  en: {
    empty: 'Enter a text message.',
    askUsage: 'Enter /ask vaultID question',
    askUnavailable: 'No verifiable answer is available. Check the vault and model permissions.',
    citation: (quote: string, reference: string) => `“${quote}”\nSource ${reference}`,
    cancelled: 'The conversation was stopped.',
    failed: 'The conversation did not finish. Check the workbench for its status.',
    completed: 'The conversation is complete.',
    deadline: (id: number) => `Update ${id} reached its processing deadline. The original intake was saved. Check the workbench before trying again.`,
    published: 'The BI review was published. Open the workbench to view the version.',
    status: (jobs: number, complete: number) => `BI jobs: ${jobs} total, ${complete} submitted for review.`,
    review: (id: number) => `Intake ${id} was submitted for review.`,
    blocked: (id: number) => `Intake ${id} needs additional information. Open the workbench.`,
    replyInstruction: 'Reply to the user in English.',
  },
};

export const channelText = (locale: ChannelLocale = 'zh-TW') => channelStrings[locale];
