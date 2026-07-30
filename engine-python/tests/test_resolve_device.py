"""resolve_device / validate_cuda_device 单元测试。

覆盖复核4 的边界值表（#29 设备字符串归一化），防止设备处理线再次回归：
  参数没传 → 传了不消费 → 入口缺参数 → 值格式不对 → 编号空间错配（五轮教训）

运行方式（项目根目录）：
    engine-python/python/python.exe engine-python/tests/test_resolve_device.py

resolve_device 为纯函数，全部用例不需要 CUDA；
validate_cuda_device 的越界/畸形用例在无 CUDA 机器上自动跳过。
pytest 环境下亦可直接收集（函数均为 test_* 命名）。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # engine-python/

from worker import resolve_device, validate_cuda_device  # noqa: E402


# ---- resolve_device：纯函数边界值（对应复核4 实测表） ----

def test_indexless_cuda_gets_index():
    # set_device 不接受无索引 'cuda'（ValueError）—— 这是复核3 抓到崩溃的场景
    assert resolve_device('cuda') == 'cuda:0'


def test_explicit_index_preserved():
    assert resolve_device('cuda:0') == 'cuda:0'
    assert resolve_device('cuda:1') == 'cuda:1'
    assert resolve_device('cuda:12') == 'cuda:12'


def test_falsy_defaults_to_cuda0():
    assert resolve_device(None) == 'cuda:0'
    assert resolve_device('') == 'cuda:0'


def test_non_cuda_falls_to_cpu():
    assert resolve_device('cpu') == 'cpu'
    # 大小写敏感：'CUDA' 不匹配 cuda 前缀，落到 cpu 分支（复核4 边界值）
    assert resolve_device('CUDA') == 'cpu'


def test_malformed_passthrough():
    # 畸形值原样透传，交给 validate_cuda_device 给中文错误，不在此层丢异常
    assert resolve_device('cuda:abc') == 'cuda:abc'


# ---- validate_cuda_device：早退路径（无需 torch） ----

def test_validate_early_return_without_index():
    validate_cuda_device('cpu')   # 非 cuda: 前缀直接返回
    validate_cuda_device('cuda')  # 无冒号同样直接返回


# ---- validate_cuda_device：越界/畸形（需 CUDA，无卡机器自动跳过） ----

def test_validate_cuda_bounds_and_malformed():
    try:
        import torch
    except ImportError:
        return
    if not torch.cuda.is_available() or torch.cuda.device_count() == 0:
        return  # 无 CUDA 环境跳过

    n = torch.cuda.device_count()

    # 合法索引：不抛异常
    validate_cuda_device(f'cuda:{n - 1}')

    # 负索引：-1 在旧代码里绕得过越界判断，落到 set_device 才抛英文 RuntimeError
    try:
        validate_cuda_device('cuda:-1')
    except SystemExit as e:
        assert e.code == 1, f'负索引退出码应为 1，实际 {e.code}'
    else:
        raise AssertionError('cuda:-1 负索引但未触发 fail')

    # 越界索引：fail() 打印中文提示并以退出码 1 结束
    try:
        validate_cuda_device(f'cuda:{n}')
    except SystemExit as e:
        assert e.code == 1, f'越界退出码应为 1，实际 {e.code}'
    else:
        raise AssertionError(f'cuda:{n} 越界但未触发 fail')

    # 畸形索引：同上
    try:
        validate_cuda_device('cuda:abc')
    except SystemExit as e:
        assert e.code == 1, f'畸形退出码应为 1，实际 {e.code}'
    else:
        raise AssertionError('cuda:abc 畸形但未触发 fail')


ALL_TESTS = [(k, v) for k, v in sorted(globals().items())
             if k.startswith('test_') and callable(v)]


def main():
    failed = 0
    for name, fn in ALL_TESTS:
        try:
            fn()
            print(f'PASS {name}')
        except AssertionError as e:
            failed += 1
            print(f'FAIL {name}: {e}')
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f'ERROR {name}: {type(e).__name__}: {e}')
    print(f'\n{len(ALL_TESTS) - failed}/{len(ALL_TESTS)} 通过')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
