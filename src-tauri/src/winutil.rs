//! Thin Win32 helpers: drives, elevation, shell actions, recycle bin.

use serde::Serialize;
use std::os::windows::process::CommandExt;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Shell::{
    SHEmptyRecycleBinW, SHQueryRecycleBinW, ShellExecuteW, SHQUERYRBINFO,
};

const DRIVE_REMOVABLE: u32 = 2;
const DRIVE_FIXED: u32 = 3;
const SW_SHOWNORMAL: i32 = 1;

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[derive(Serialize, Clone)]
pub struct Drive {
    pub path: String,
    pub label: String,
    pub fs: String,
    pub total: u64,
    pub free: u64,
    pub removable: bool,
}

pub fn volume_info(root: &str) -> Option<(String, String)> {
    let w = wide(root);
    let mut label = [0u16; 261];
    let mut fs = [0u16; 64];
    let (mut serial, mut maxc, mut flags) = (0u32, 0u32, 0u32);
    let ok = unsafe {
        GetVolumeInformationW(
            w.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            &mut serial,
            &mut maxc,
            &mut flags,
            fs.as_mut_ptr(),
            fs.len() as u32,
        )
    };
    if ok == 0 {
        return None;
    }
    let s = |b: &[u16]| {
        String::from_utf16_lossy(&b[..b.iter().position(|&c| c == 0).unwrap_or(b.len())])
    };
    Some((s(&label), s(&fs)))
}

pub fn list_drives() -> Vec<Drive> {
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + i as u8) as char);
        let w = wide(&root);
        let ty = unsafe { GetDriveTypeW(w.as_ptr()) };
        if ty != DRIVE_FIXED && ty != DRIVE_REMOVABLE {
            continue;
        }
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        if unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) } == 0 {
            continue;
        }
        let (label, fs) = volume_info(&root).unwrap_or_default();
        out.push(Drive {
            path: root,
            label,
            fs,
            total,
            free,
            removable: ty == DRIVE_REMOVABLE,
        });
    }
    out
}

pub fn is_admin() -> bool {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            &mut elev as *mut _ as *mut _,
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        CloseHandle(token);
        ok != 0 && elev.TokenIsElevated != 0
    }
}

fn shell_execute(verb: &str, file: &str) -> bool {
    let v = wide(verb);
    let f = wide(file);
    let r = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            v.as_ptr(),
            f.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    r as isize > 32
}

/// Restarts the app elevated. Returns false if the user declined UAC.
pub fn relaunch_elevated() -> bool {
    match std::env::current_exe() {
        Ok(exe) => shell_execute("runas", &exe.to_string_lossy()),
        Err(_) => false,
    }
}

pub fn open_item(path: &str) -> bool {
    shell_execute("open", path)
}

pub fn reveal(path: &str) {
    let _ = std::process::Command::new("explorer.exe")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn();
}

pub fn recycle_bin() -> (u64, u64) {
    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        i64Size: 0,
        i64NumItems: 0,
    };
    let hr = unsafe { SHQueryRecycleBinW(std::ptr::null(), &mut info) };
    if hr < 0 {
        return (0, 0);
    }
    (info.i64NumItems.max(0) as u64, info.i64Size.max(0) as u64)
}

pub fn empty_recycle_bin() -> Result<(), String> {
    const FLAGS: u32 = 0x1 | 0x2 | 0x4; // no confirmation, no progress UI, no sound
    let hr = unsafe { SHEmptyRecycleBinW(std::ptr::null_mut(), std::ptr::null(), FLAGS) };
    // E_UNEXPECTED (0x8000FFFF) is returned when the bin is already empty.
    if hr >= 0 || hr as u32 == 0x8000_FFFF {
        Ok(())
    } else {
        Err(format!("SHEmptyRecycleBin failed (0x{:08X})", hr as u32))
    }
}

/// Paths that must never be deleted from the UI.
pub fn is_protected(path: &str) -> bool {
    let p = path.trim_end_matches('\\').to_lowercase();
    if p.len() <= 2 {
        return true; // drive root
    }
    let name = p.rsplit('\\').next().unwrap_or("");
    let depth = p.matches('\\').count();
    if depth == 1
        && (name.starts_with('$') || name == "system volume information" || name.ends_with(".sys"))
    {
        return true; // NTFS metadata, recycle bin root, pagefile/hiberfil/swapfile
    }
    let env = |k: &str| {
        std::env::var(k)
            .ok()
            .map(|v| v.trim_end_matches('\\').to_lowercase())
    };
    let sysroot = env("SystemRoot").unwrap_or_else(|| "c:\\windows".into());
    if p == sysroot || p.starts_with(&format!("{sysroot}\\")) {
        return true; // all of Windows
    }
    let exact = [
        env("ProgramFiles"),
        env("ProgramFiles(x86)"),
        env("ProgramW6432"),
        env("ProgramData"),
        env("USERPROFILE"),
        env("APPDATA"),
        env("LOCALAPPDATA"),
        env("PUBLIC"),
        p.get(..2).map(|d| format!("{d}\\users")),
        env("USERPROFILE").map(|u| format!("{u}\\appdata")),
        env("USERPROFILE").map(|u| format!("{u}\\documents")),
        env("USERPROFILE").map(|u| format!("{u}\\desktop")),
    ];
    exact.iter().flatten().any(|e| *e == p)
}
