#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抖音视频下载器 —— 图形界面

双击 抖音下载器.bat 启动。后端是 dy_dl.py（Playwright 借浏览器签名）。
"""

import pathlib
import queue
import sys
import threading
import tkinter as tk
from tkinter import messagebox, ttk

import dy_dl

BASE = pathlib.Path(__file__).resolve().parent
OUT_DIR = BASE / '下载'


class App:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.busy = False

        root.title('抖音视频下载器')
        root.geometry('760x600')
        root.minsize(660, 520)
        root.configure(bg='#ffffff')

        self._build()
        self._poll()
        self.log('就绪。粘贴抖音链接或整段分享口令，点「开始下载」。')
        self.log('原理：启动一个独立的 Edge 借浏览器签名拿直链，不会影响你正在用的浏览器。')

    def _build(self):
        st = ttk.Style()
        try:
            st.theme_use('vista')
        except Exception:
            pass
        st.configure('.', font=('Microsoft YaHei UI', 10))
        st.configure('T.TLabel', font=('Microsoft YaHei UI', 15, 'bold'), background='#ffffff')
        st.configure('H.TLabel', foreground='#6b6b6b', background='#ffffff')
        st.configure('Go.TButton', font=('Microsoft YaHei UI', 11, 'bold'), padding=(20, 9))

        pad = {'padx': 18}

        head = tk.Frame(self.root, bg='#ffffff')
        head.pack(fill='x', pady=(16, 2), **pad)
        ttk.Label(head, text='抖音视频下载器', style='T.TLabel').pack(side='left')
        self.state = ttk.Label(head, text='空闲', style='H.TLabel')
        self.state.pack(side='right')

        ttk.Label(self.root, text='粘贴链接或整段分享口令（多个一行一个）',
                  style='H.TLabel').pack(anchor='w', pady=(10, 4), **pad)

        self.txt = tk.Text(self.root, height=7, wrap='word', relief='solid', bd=1,
                           font=('Consolas', 10), bg='#fcfcfc', highlightthickness=0)
        self.txt.pack(fill='x', **pad)

        row = tk.Frame(self.root, bg='#ffffff')
        row.pack(fill='x', pady=10, **pad)
        self.btn = ttk.Button(row, text='开始下载', style='Go.TButton', command=self.start)
        self.btn.pack(side='left')
        ttk.Button(row, text='打开文件夹', command=self.open_dir).pack(side='left', padx=8)
        ttk.Button(row, text='清空日志', command=self.clear).pack(side='left')

        logf = tk.Frame(self.root, bg='#ffffff')
        logf.pack(fill='both', expand=True, pady=(2, 16), **pad)
        self.box = tk.Text(logf, wrap='word', relief='solid', bd=1, state='disabled',
                           font=('Consolas', 9), bg='#fbfbfb', highlightthickness=0)
        sb = ttk.Scrollbar(logf, command=self.box.yview)
        self.box.configure(yscrollcommand=sb.set)
        self.box.pack(side='left', fill='both', expand=True)
        sb.pack(side='right', fill='y')

    def log(self, msg):
        self.box.configure(state='normal')
        self.box.insert('end', str(msg) + '\n')
        self.box.see('end')
        self.box.configure(state='disabled')

    def clear(self):
        self.box.configure(state='normal')
        self.box.delete('1.0', 'end')
        self.box.configure(state='disabled')

    def open_dir(self):
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        try:
            import os
            os.startfile(str(OUT_DIR))
        except Exception as e:
            messagebox.showerror('打开失败', str(e))

    def start(self):
        if self.busy:
            return
        text = self.txt.get('1.0', 'end')
        targets = dy_dl.extract_targets(text)
        if not targets:
            messagebox.showwarning('没有链接', '没识别到抖音链接。\n支持 v.douyin.com 短链、www.douyin.com/video/… 和视频 ID。')
            return
        self.busy = True
        self.btn.configure(state='disabled', text='下载中…')
        self.state.configure(text=f'处理 {len(targets)} 个')
        self.log('')
        self.log(f'=== 收到 {len(targets)} 个目标 ===')
        threading.Thread(target=self._worker, args=(targets,), daemon=True).start()

    def _worker(self, targets):
        try:
            results = dy_dl.download(
                targets, out_dir=OUT_DIR,
                log=lambda m: self.q.put(('log', m)),
                headless=True, force=False)
            ok = sum(1 for _, s, _ in results if s)
            self.q.put(('log', ''))
            self.q.put(('log', f'=== 完成：成功 {ok} / {len(results)} ==='))
            self.q.put(('log', f'=== 目录：{OUT_DIR} ==='))
            self.q.put(('done', len(results)))
        except Exception as e:
            self.q.put(('log', f'[严重错误] {type(e).__name__}: {e}'))
            self.q.put(('done', 0))

    def _poll(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == 'log':
                    self.log(val)
                elif kind == 'done':
                    self.busy = False
                    self.btn.configure(state='normal', text='开始下载')
                    self.state.configure(text='空闲')
        except queue.Empty:
            pass
        self.root.after(120, self._poll)


def main():
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == '__main__':
    main()
