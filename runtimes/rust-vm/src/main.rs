use scratch_vm::{CliFrontend, Project, Runtime, Target};
use std::{
    fs::File,
    io::{self, Write},
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::args_os()
        .nth(1)
        .ok_or("usage: scratch-bench-rust-vm PROJECT.sb3")?;
    let mut archive = zip::ZipArchive::new(File::open(file)?)?;
    let json = serde_json::from_reader(archive.by_name("project.json")?)?;
    let mut runtime = Runtime::new(Project::load_json(&json)?);
    runtime.config.quiet_logs = true;
    let stage = *runtime
        .project
        .targets
        .iter()
        .find(|(_, target)| matches!(target, Target::Stage { .. }))
        .map(|(id, _)| id)
        .ok_or("project has no stage")?;
    let list_id = runtime.scratch.targets[&stage]
        .lists
        .iter()
        .find(|(_, list)| list.name == "output")
        .map(|(id, _)| id.clone())
        .ok_or("project has no output list")?;

    // Match upstream's benchmark frontend: unthrottled ticks, real wall time.
    // A tick can just exhaust an instruction budget, even inside a warp loop;
    // sleeping per tick would throttle execution, not just display refreshes.
    let mut frontend = CliFrontend::with_io(io::empty(), io::sink(), io::stderr());
    frontend.headless = true;
    runtime.green_flag().await?;
    frontend.process_effects(&mut runtime)?;
    let mut printed = 0;
    loop {
        let result = frontend.tick(&mut runtime).await;
        let items = &runtime.scratch.targets[&stage].lists[&list_id].items;
        printed = printed.min(items.len());
        for item in &items[printed..] {
            println!("[PROJECT] {item}");
        }
        io::stdout().flush()?;
        printed = items.len();
        result?;
        if runtime.is_idle() {
            break;
        }
        tokio::task::yield_now().await;
    }
    Ok(())
}
