import { EventEmitter } from 'events';
import path from 'path';

export class EventParser extends EventEmitter {
  constructor() {
    super();
    this.currentStep = 0;
  }

  processLine(line) {
    try {
      const data = JSON.parse(line);
      const { type, source, status, step_index, tool_calls, content } = data;

      if (typeof step_index === 'number') {
        this.currentStep = step_index;
      }

      // 1. 用户输入触发
      if (type === 'USER_INPUT') {
        this.emit('status', {
          state: 'working',
          title: 'Antigravity 正在分析需求...',
          detail: '接收到用户新指令',
          step: this.currentStep,
          ts: Date.now()
        });
        return;
      }

      // 2. 模型执行阶段
      if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
        // 如果有工具调用
        if (Array.isArray(tool_calls) && tool_calls.length > 0) {
          const call = tool_calls[0];
          const name = call.name || 'tool';
          const args = call.args || {};

          let summary = args.toolSummary;
          if (summary) {
            summary = summary.replace(/^["']|["']$/g, '');
          }

          let detail = '';
          if (name === 'run_command' && args.CommandLine) {
            const cmd = args.CommandLine.replace(/^["']|["']$/g, '').trim();
            detail = `[命令] ${cmd.length > 45 ? cmd.slice(0, 42) + '...' : cmd}`;
          } else if ((name === 'edit_file' || name === 'write_file' || name === 'read_file') && args.Path) {
            const base = path.basename(args.Path.replace(/^["']|["']$/g, ''));
            const action = name === 'read_file' ? '读取' : '编辑';
            detail = `[${action}] ${base}`;
          } else if (name === 'search_web' && args.query) {
            detail = `[搜索] ${args.query}`;
          } else if (name === 'ask_question') {
            this.emit('status', {
              state: 'waiting',
              title: 'Antigravity 等待用户选择...',
              detail: '请点击反重力窗口完成选项',
              step: this.currentStep,
              ts: Date.now()
            });
            return;
          } else {
            detail = `[${name}] 执行中`;
          }

          const title = summary ? `${summary} (#${this.currentStep})` : `执行中: ${name} (#${this.currentStep})`;

          this.emit('status', {
            state: 'working',
            title,
            detail,
            step: this.currentStep,
            ts: Date.now()
          });
          return;
        }

        // 如果没有工具调用且状态为 DONE，说明当前轮次回复结束
        if (status === 'DONE' && (!tool_calls || tool_calls.length === 0)) {
          this.emit('status', {
            state: 'completed',
            title: 'Antigravity 任务已完成',
            detail: 'Agent STANDBY · 等待下一指令',
            step: this.currentStep,
            ts: Date.now()
          });
          return;
        }
      }
    } catch (e) {
      // 容错忽略非 JSON 字符
    }
  }
}
