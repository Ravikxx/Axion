#include "axon/thread_pool.h"

#ifdef _WIN32
#  include <windows.h>
#  include <vector>
#else
#  include <unistd.h>
#  include <fstream>
#  include <string>
#  include <set>
#endif

namespace axon {

// Physical core count — not hyperthreads.
// Hyperthreads share the floating-point execution unit, so they don't
// help (and can hurt) heavy matrix math. We size the pool to physical cores.
int ThreadPool::default_thread_count() {
#ifdef _WIN32
    DWORD len = 0;
    GetLogicalProcessorInformation(nullptr, &len);
    std::vector<SYSTEM_LOGICAL_PROCESSOR_INFORMATION> buf(
        len / sizeof(SYSTEM_LOGICAL_PROCESSOR_INFORMATION));
    GetLogicalProcessorInformation(buf.data(), &len);
    int count = 0;
    for (auto& item : buf)
        if (item.Relationship == RelationProcessorCore) ++count;
    return count > 0 ? count : 1;
#else
    std::ifstream f("/proc/cpuinfo");
    std::set<std::pair<int,int>> seen;
    int phys = 0, core = 0;
    std::string line;
    while (std::getline(f, line)) {
        auto colon = line.find(':');
        if (colon == std::string::npos) { seen.insert({phys, core}); continue; }
        int val = 0;
        try { val = std::stoi(line.substr(colon + 1)); } catch (...) { continue; }
        if (line.rfind("physical id", 0) == 0) phys = val;
        if (line.rfind("core id",     0) == 0) core = val;
    }
    int count = static_cast<int>(seen.size());
    if (count == 0) count = static_cast<int>(sysconf(_SC_NPROCESSORS_ONLN)) / 2;
    return count > 0 ? count : 1;
#endif
}

ThreadPool::ThreadPool(int num_threads) {
    if (num_threads <= 0) num_threads = default_thread_count();

    workers_.reserve(num_threads);
    for (int i = 0; i < num_threads; ++i) {
        workers_.emplace_back([this] {
            // Each worker loops forever: grab a task, run it, repeat.
            // When stop_ is set and the queue is empty, the thread exits.
            for (;;) {
                std::function<void()> task;
                {
                    std::unique_lock<std::mutex> lock(queue_mu_);
                    // Wait until there's a task OR we're stopping
                    cv_.wait(lock, [this] {
                        return stop_.load() || !task_queue_.empty();
                    });
                    if (stop_ && task_queue_.empty()) return;
                    task = std::move(task_queue_.front());
                    task_queue_.pop();
                }
                task();  // run outside the lock so other threads can pick up work
            }
        });
    }
}

ThreadPool::~ThreadPool() {
    stop_.store(true);
    cv_.notify_all();  // wake all waiting threads so they see stop_ = true
    for (auto& w : workers_) {
        if (w.joinable()) w.join();  // wait for each thread to finish its current task
    }
}

} // namespace axon
