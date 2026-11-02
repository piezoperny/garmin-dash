"""
src/ingestion/bootstrap_garmin.py
Native Windows GUI login window (with working Ctrl+V & Show Password toggle)
that logs into Garmin Connect and copies your GARMIN_TOKEN to the clipboard.
"""

from __future__ import annotations

import base64
import subprocess
import tkinter as tk
from tkinter import messagebox, simpledialog

from src.ingestion.garmin_client import LiveGarminClient


def copy_to_clipboard(text: str) -> bool:
    try:
        subprocess.run("clip", input=text.encode("utf-8"), check=True, shell=True)
        return True
    except Exception:
        return False


def main() -> None:
    root = tk.Tk()
    root.title("Garmin Connect — 1-Click Token Generator")
    root.geometry("430x270")
    root.configure(bg="#111114")
    root.resizable(False, False)

    tk.Label(
        root,
        text="Garmin Connect Login",
        font=("Segoe UI", 13, "bold"),
        fg="#f4f4f5",
        bg="#111114",
    ).pack(pady=(16, 4))

    tk.Label(
        root,
        text="Ctrl+V works normally here. Generates & copies your token.",
        font=("Segoe UI", 9),
        fg="#a1a1aa",
        bg="#111114",
    ).pack(pady=(0, 12))

    form = tk.Frame(root, bg="#111114")
    form.pack(padx=24, fill="x")

    tk.Label(form, text="Email:", font=("Segoe UI", 9, "bold"), fg="#d4d4d8", bg="#111114").grid(
        row=0, column=0, sticky="w", pady=6
    )
    email_entry = tk.Entry(form, width=36, font=("Segoe UI", 10), bg="#18181b", fg="#ffffff", insertbackground="#ffffff")
    email_entry.grid(row=0, column=1, padx=(10, 0), pady=6)
    email_entry.focus_set()

    tk.Label(form, text="Password:", font=("Segoe UI", 9, "bold"), fg="#d4d4d8", bg="#111114").grid(
        row=1, column=0, sticky="w", pady=6
    )
    pwd_entry = tk.Entry(form, width=36, font=("Segoe UI", 10), show="*", bg="#18181b", fg="#ffffff", insertbackground="#ffffff")
    pwd_entry.grid(row=1, column=1, padx=(10, 0), pady=6)

    show_var = tk.BooleanVar(value=False)

    def toggle_pwd() -> None:
        pwd_entry.config(show="" if show_var.get() else "*")

    tk.Checkbutton(
        form,
        text="Show password (verify Ctrl+V)",
        variable=show_var,
        command=toggle_pwd,
        font=("Segoe UI", 9),
        fg="#a1a1aa",
        bg="#111114",
        selectcolor="#18181b",
        activebackground="#111114",
        activeforeground="#ffffff",
    ).grid(row=2, column=1, sticky="w", padx=(10, 0), pady=(2, 8))

    status_lbl = tk.Label(root, text="", font=("Segoe UI", 9), fg="#10b981", bg="#111114")
    status_lbl.pack(pady=(2, 4))

    def do_login() -> None:
        email = email_entry.get().strip()
        password = pwd_entry.get().strip()
        if not email or not password:
            messagebox.showwarning("Missing Info", "Please enter both your Garmin email and password.")
            return

        status_lbl.config(text="Logging in to Garmin Connect...", fg="#38bdf8")
        root.update()

        try:
            from garminconnect import Garmin

            def ask_mfa() -> str:
                code = simpledialog.askstring(
                    "Garmin 2FA Code",
                    "Enter the 2FA security code Garmin sent to your email/phone:",
                    parent=root,
                )
                return (code or "").strip()

            garmin = Garmin(email=email, password=password, prompt_mfa=ask_mfa)
            garmin.login()

            raw_json = LiveGarminClient._export_personal_tokenstore(garmin)
            token_string = "GARMIN_TOKEN:" + base64.b64encode(raw_json.encode("utf-8")).decode("ascii")
            copy_to_clipboard(token_string)
            root.clipboard_clear()
            root.clipboard_append(token_string)
            root.update()

            status_lbl.config(text="Success! Token copied to clipboard!", fg="#10b981")
            messagebox.showinfo(
                "Token Copied to Clipboard!",
                "Logged in successfully!\n\n"
                "Your GARMIN_TOKEN:... string is now on your clipboard.\n"
                "Paste it (Ctrl+V) into GARMIN_CLIENT_SECRET in your GitHub repo secrets.",
            )
            root.destroy()
        except Exception as e:
            status_lbl.config(text="Login failed — see error popup.", fg="#f43f5e")
            messagebox.showerror("Garmin Login Failed", f"Garmin returned an error:\n\n{e}")

    btn = tk.Button(
        root,
        text="Log In & Copy Token to Clipboard",
        command=do_login,
        font=("Segoe UI", 10, "bold"),
        bg="#10b981",
        fg="#09090b",
        activebackground="#059669",
        relief="flat",
        padx=16,
        pady=6,
        cursor="hand2",
    )
    btn.pack(pady=(6, 10))
    root.bind("<Return>", lambda _e: do_login())
    root.mainloop()


if __name__ == "__main__":
    main()
