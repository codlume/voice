// Samples every process in a root pid's tree: OS physical footprint (the value Activity Monitor
// and `footprint` report) and cumulative CPU time. One JSON line per tick on stdout.
// Usage: footprint <root pid> <interval ms>
import Darwin
import Foundation

let root = pid_t(CommandLine.arguments[1])!
let interval = UInt32(CommandLine.arguments[2])! * 1000
var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)

func children(_ pid: pid_t) -> [pid_t] {
  var buffer = [pid_t](repeating: 0, count: 512)
  let count = proc_listchildpids(pid, &buffer, Int32(buffer.count * MemoryLayout<pid_t>.size))
  return count > 0 ? Array(buffer.prefix(Int(count))) : []
}
func tree(_ pid: pid_t) -> [pid_t] { [pid] + children(pid).flatMap(tree) }
func name(_ pid: pid_t) -> String {
  var buffer = [CChar](repeating: 0, count: 1024)
  return proc_name(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : "?"
}

setvbuf(stdout, nil, _IOLBF, 0)
while kill(root, 0) == 0 {
  let at = Date().timeIntervalSince1970 * 1000
  var processes: [String] = []
  for pid in tree(root) {
    var usage = rusage_info_v4()
    let status = withUnsafeMutablePointer(to: &usage) {
      $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
        proc_pid_rusage(pid, RUSAGE_INFO_V4, $0)
      }
    }
    guard status == 0 else { continue }
    let cpu = (usage.ri_user_time + usage.ri_system_time) * UInt64(timebase.numer)
      / UInt64(timebase.denom)
    let label = name(pid).replacingOccurrences(of: "\"", with: "'")
    processes.append(
      "{\"pid\":\(pid),\"name\":\"\(label)\",\"footprint\":\(usage.ri_phys_footprint),\"cpuNs\":\(cpu)}"
    )
  }
  print("{\"at\":\(Int(at)),\"processes\":[\(processes.joined(separator: ","))]}")
  usleep(interval)
}
