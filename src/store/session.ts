// 登录态。任务 5 的 core 已就绪(OAuth PKCE + 钥匙串),这里只是外壳上的入口:
// 侧边栏底部那一行。完整登录页不在本任务范围(商店可先于登录浏览)。
import { create } from "zustand";

import { t } from "@/i18n";
import { authLoginOauth, authLogout, authStatus, isAppError, type AppError, type SessionUser } from "@/lib/ipc";

type Status = "unknown" | "signedOut" | "signedIn" | "signingIn";

interface SessionState {
  status: Status;
  user: SessionUser | null;
  error: AppError | null;
  refresh: () => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  status: "unknown",
  user: null,
  error: null,

  refresh: async () => {
    try {
      const s = await authStatus();
      set({
        status: s.loggedIn ? "signedIn" : "signedOut",
        user: s.user ?? null,
        error: null,
      });
    } catch (raw) {
      // 查登录态失败不该拦住浏览:按未登录处理,把错误留给点击登录时再显示
      set({ status: "signedOut", user: null, error: isAppError(raw) ? raw : null });
    }
  },

  signIn: async () => {
    set({ status: "signingIn", error: null });
    try {
      const user = await authLoginOauth();
      set({ status: "signedIn", user, error: null });
    } catch (raw) {
      set({
        status: "signedOut",
        user: null,
        error: isAppError(raw) ? raw : { code: "AUTH_FAILED", message: t("error.signInFailed") },
      });
    }
  },

  signOut: async () => {
    await authLogout().catch(() => {});
    set({ status: "signedOut", user: null, error: null });
  },
}));
