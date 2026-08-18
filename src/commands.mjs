const COMMAND_ALIASES = new Map([
  ['/帮助', '/help'],
  ['/指令帮助', '/help'],
  ['/状态', '/status'],
  ['/新建对话', '/new'],
  ['/停止', '/stop'],
  ['/项目', '/project'],
  ['/只读', '/readonly'],
  ['/可写', '/write'],
  ['/选择对话', '/threads'],
  ['/选择会话', '/threads'],
  ['/恢复对话', '/resume'],
  ['/发送', '/send'],
  ['/变更', '/diff'],
  ['/测试审批', '/test-approval'],
  ['/选择模型', '/model'],
]);

export function parseCommand(text) {
  const value = text.trim(); if (!value.startsWith('/')) return null;
  const [name, ...args] = value.split(/\s+/);
  const normalizedName = name.toLowerCase();
  return { name: COMMAND_ALIASES.get(normalizedName) || normalizedName, args, rawArgs: value.slice(name.length).trim() };
}

export const HELP = `**本机 Codex 控制命令**

/选择对话 列出对话，再输入序号进入（兼容 /threads）  
/新建对话 立即新建空白对话（兼容 /new）  
/选择模型 列出当前账号可用模型，再输入序号选择（兼容 /model）  
/状态 查看当前项目、对话、模型和执行状态（兼容 /status）  
/停止 停止当前执行（兼容 /stop）  
/项目 list 查看允许的项目  
/项目 use <项目ID> 切换项目  
/只读 切换为只读模式  
/可写 切换为项目目录可写模式  
/恢复对话 <线程ID或序号> 恢复对话  
/发送 <线程ID或序号> <消息> 向指定对话发消息  
/变更 查看本轮文件变更  
/测试审批 测试审批卡片全链路  
/帮助 查看帮助（也可使用 /指令帮助）

**英文指令及含义**

/threads 列出全部可选对话，再输入序号进入  
/new 立即新建一个空白对话  
/model 列出当前账号可用模型，再输入序号选择  
/model <模型ID> 直接选择指定的可用模型  
/status 查看当前项目、对话、模型和执行状态  
/stop 停止当前正在执行的任务  
/project list 列出允许操作的项目  
/project use <项目ID> 切换到指定项目  
/readonly 切换为只读模式  
/write 切换为当前项目目录可写模式  
/resume <线程ID或序号> 恢复指定对话  
/send <线程ID或序号> <消息> 向指定对话发送消息  
/diff 查看本轮任务的文件变更  
/test-approval 测试企业微信审批卡片全链路  
/help 查看中英文指令帮助

所有系统操作都必须以 /开头。不以 /开头的其他文本会发送给本机 Codex；执行中发送文本会作为补充指令。`;
