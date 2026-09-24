; SkillSync 的 NSIS 安装钩子(tauri.conf.json -> bundle.windows.nsis.installerHooks)。
;
; 0.7.1 真机:安装包图标换成品牌图标后,exe 内嵌的 6 档图标全是新的(已解包核实),
; 窗口标题栏与托盘也是新的——唯独**任务栏上固定的快捷方式**还显示旧图标。
; 原因是 Windows 的图标缓存:exe 换了图标,已固定的快捷方式不会自己去重新取。
; 这里在安装(含自动更新的静默安装)完成后刷新当前用户的图标缓存。
;
; - Tauri 的安装器是 32 位 NSIS:64 位系统上 $SYSDIR 被重定向到 SysWOW64,
;   所以优先走 Sysnative 调 64 位的 ie4uinit;没有 Sysnative(32 位系统)才用 $SYSDIR。
; - `ie4uinit.exe -show` 是 Win10/11 上刷新当前用户图标缓存的系统自带做法,不需要管理员权限
;   (本应用按当前用户安装,与之一致)。失败只意味着图标晚些才换,**绝不能拦住安装**,
;   所以返回值出栈丢弃、不做任何判断。
; - 再发一次 SHCNE_ASSOCCHANGED 通知资源管理器重读图标(0x08000000,flags 0)。

!macro NSIS_HOOK_POSTINSTALL
  ${If} ${FileExists} "$WINDIR\Sysnative\ie4uinit.exe"
    nsExec::Exec '"$WINDIR\Sysnative\ie4uinit.exe" -show'
  ${Else}
    nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
  ${EndIf}
  Pop $0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
