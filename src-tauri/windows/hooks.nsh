; nsis 安装包的钩子（tauri.conf.json 的 bundle.windows.nsis.installerHooks）。
;
; 卸载前让程序自己把写进 Dota 目录的 GSI 配置删掉。不在这里用 NSIS 脚本删：
; Dota 可能装在 Steam 的任何一个库里，找库的逻辑 gsicfg.rs 里已经有了，别再抄一份。
; 程序带 --cleanup 启动时只做这一件事就退出，不起窗口（见 main.rs）。
;
; 一键更新装新版本时不走卸载，这个钩子不会跑；就算跑了也无害——程序下次启动会重新写配置。
!macro NSIS_HOOK_PREUNINSTALL
  ExecWait '"$INSTDIR\dota2-game-helper2.exe" --cleanup'
!macroend
