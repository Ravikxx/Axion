#pragma once
#include <functional>
#include <vector>
#include <queue>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <future>
#include <atomic>
#include <stdexcept>

// A thread pool keeps N worker threads alive and feeds them tasks.
// This is faster than spawning a new thread per operation (threads are expensive to create).
// For the Ryzen 5825U: 8 physical cores → we spawn 8 threads.
// Hyperthreading (16 logical cores) doesn't help for heavy float math — physical cores only.

namespace axon {

class ThreadPool {
public:
    // num_threads = -1: auto-detect physical cores
    explicit ThreadPool(int num_threads = -1);
    ~ThreadPool();

    ThreadPool(const ThreadPool&)            = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    // Submit a callable and get back a std::future to retrieve the result later.
    // Usage: auto fut = pool.submit(my_fn, arg1, arg2);  result = fut.get();
    template<typename F, typename... Args>
    auto submit(F&& f, Args&&... args)
        -> std::future<std::invoke_result_t<F, Args...>>;

    int  num_threads()  const { return static_cast<int>(workers_.size()); }
    bool is_stopped()   const { return stop_.load(); }

private:
    std::vector<std::thread>          workers_;
    std::queue<std::function<void()>> task_queue_;
    std::mutex                        queue_mu_;
    std::condition_variable           cv_;
    std::atomic<bool>                 stop_{false};

    static int default_thread_count();
};

// --- Template implementation (must live in header) ---

template<typename F, typename... Args>
auto ThreadPool::submit(F&& f, Args&&... args)
    -> std::future<std::invoke_result_t<F, Args...>>
{
    using R = std::invoke_result_t<F, Args...>;

    auto task = std::make_shared<std::packaged_task<R()>>(
        std::bind(std::forward<F>(f), std::forward<Args>(args)...)
    );
    std::future<R> fut = task->get_future();

    {
        std::unique_lock<std::mutex> lock(queue_mu_);
        if (stop_) throw std::runtime_error("axon::ThreadPool: submit after stop");
        task_queue_.emplace([task]() { (*task)(); });
    }
    cv_.notify_one();
    return fut;
}

} // namespace axon
