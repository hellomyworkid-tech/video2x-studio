# -*- coding: utf-8 -*-
"""Pure-PyTorch port of RealBasicVSR (CVPR 2022).

Ported from OpenMMLab mmagic:
  - mmagic/models/editors/real_basicvsr/real_basicvsr_net.py
  - mmagic/models/editors/basicvsr/basicvsr_net.py  (BasicVSRNet / SPyNet / ResidualBlocksWithInputConv)
  - mmagic/models/archs/upsample.py                (PixelShufflePack)
  - mmagic/models/archs/resnet.py                  (ResidualBlockNoBN)
  - mmagic/models/utils (flow_warp / make_layer)

All mmcv / mmengine / registry dependencies removed. No custom CUDA ops;
only Conv2d, PixelShuffle and F.grid_sample, so it runs on any PyTorch build.

Original code copyright OpenMMLab, released under Apache-2.0.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def make_layer(basic_block, num_blocks, **kwarg):
    layers = [basic_block(**kwarg) for _ in range(num_blocks)]
    return nn.Sequential(*layers)


def flow_warp(x, flow, interpolation='bilinear', padding_mode='zeros', align_corners=True):
    """Warp an image or feature map with optical flow.

    Args:
        x (Tensor): shape (n, c, h, w)
        flow (Tensor): shape (n, h, w, 2)
    """
    if x.size()[-2:] != flow.size()[1:3]:
        raise ValueError(f'The spatial sizes of input ({x.size()[-2:]}) and '
                         f'flow ({flow.size()[1:3]}) do not match.')
    n, _, h, w = x.size()
    grid_y, grid_x = torch.meshgrid(
        torch.arange(h, device=x.device), torch.arange(w, device=x.device),
        indexing='ij')
    grid = torch.stack((grid_x, grid_y), dim=2).type_as(x)  # (h, w, 2)
    grid.requires_grad = False

    grid_flow = grid + flow
    grid_flow_x = 2.0 * grid_flow[:, :, :, 0] / max(w - 1, 1) - 1.0
    grid_flow_y = 2.0 * grid_flow[:, :, :, 1] / max(h - 1, 1) - 1.0
    grid_flow = torch.stack((grid_flow_x, grid_flow_y), dim=3)

    return F.grid_sample(
        x, grid_flow, mode=interpolation, padding_mode=padding_mode,
        align_corners=align_corners)


class ResidualBlockNoBN(nn.Module):
    """Residual block without BN: conv3x3 -> ReLU -> conv3x3, residual add."""

    def __init__(self, mid_channels=64, res_scale=1.0):
        super().__init__()
        self.res_scale = res_scale
        self.conv1 = nn.Conv2d(mid_channels, mid_channels, 3, 1, 1, bias=True)
        self.conv2 = nn.Conv2d(mid_channels, mid_channels, 3, 1, 1, bias=True)
        self.relu = nn.ReLU(inplace=True)

    def forward(self, x):
        identity = x
        out = self.conv2(self.relu(self.conv1(x)))
        return identity + out * self.res_scale


class PixelShufflePack(nn.Module):
    """Conv -> PixelShuffle upsampling."""

    def __init__(self, in_channels, out_channels, scale_factor, upsample_kernel):
        super().__init__()
        self.upsample_conv = nn.Conv2d(
            in_channels, out_channels * scale_factor * scale_factor,
            upsample_kernel, padding=(upsample_kernel - 1) // 2)
        self.scale_factor = scale_factor

    def forward(self, x):
        return F.pixel_shuffle(self.upsample_conv(x), self.scale_factor)


class ResidualBlocksWithInputConv(nn.Module):
    """Input conv (channel matching) followed by N residual blocks."""

    def __init__(self, in_channels, out_channels=64, num_blocks=30):
        super().__init__()
        main = [
            nn.Conv2d(in_channels, out_channels, 3, 1, 1, bias=True),
            nn.LeakyReLU(negative_slope=0.1, inplace=True),
            make_layer(ResidualBlockNoBN, num_blocks, mid_channels=out_channels),
        ]
        self.main = nn.Sequential(*main)

    def forward(self, feat):
        return self.main(feat)


# ---------------------------------------------------------------------------
# SPyNet (optical flow)
# ---------------------------------------------------------------------------

class SPyNetBasicModule(nn.Module):

    def __init__(self):
        super().__init__()
        def c(i, o, act=True):
            layers = [nn.Conv2d(i, o, 7, 1, 3, bias=True)]
            if act:
                layers.append(nn.ReLU(inplace=True))
            return layers
        chans = [(8, 32), (32, 64), (64, 32), (32, 16), (16, 2)]
        seq = []
        for idx, (i, o) in enumerate(chans):
            seq.extend(c(i, o, act=(idx < len(chans) - 1)))
        # keep the same hierarchical naming as mmengine's ConvModule so the
        # official checkpoint keys (basic_module.{i}.conv.*) still match
        self.basic_module = nn.Sequential(*[
            _NamedConv(*c_) for c_ in zip(chans, [True] * 4 + [False])])

    def forward(self, x):
        return self.basic_module(x)


class _NamedConv(nn.Module):
    """Conv(+ReLU) wrapped so state-dict keys look like `{i}.conv.weight`."""

    def __init__(self, chans, act):
        super().__init__()
        i, o = chans
        self.conv = nn.Conv2d(i, o, 7, 1, 3, bias=True)
        self.act = nn.ReLU(inplace=True) if act else None

    def forward(self, x):
        x = self.conv(x)
        if self.act is not None:
            x = self.act(x)
        return x


class SPyNet(nn.Module):
    """Spatial-pyramid optical-flow network (no BN version used by BasicVSR)."""

    def __init__(self):
        super().__init__()
        self.basic_module = nn.ModuleList([SPyNetBasicModule() for _ in range(6)])
        self.register_buffer('mean', torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1))

    def compute_flow(self, ref, supp):
        n, _, h, w = ref.size()

        ref = [(ref - self.mean) / self.std]
        supp = [(supp - self.mean) / self.std]
        for _ in range(5):
            ref.append(F.avg_pool2d(ref[-1], 2, 2, count_include_pad=False))
            supp.append(F.avg_pool2d(supp[-1], 2, 2, count_include_pad=False))
        ref = ref[::-1]
        supp = supp[::-1]

        flow = ref[0].new_zeros(n, 2, h // 32, w // 32)
        for level in range(len(ref)):
            if level > 0:
                flow_up = F.interpolate(
                    flow, scale_factor=2, mode='bilinear', align_corners=True) * 2.0
            else:
                flow_up = flow
            flow = flow_up + self.basic_module[level](
                torch.cat([
                    ref[level],
                    flow_warp(supp[level], flow_up.permute(0, 2, 3, 1),
                              padding_mode='border'),
                    flow_up,
                ], dim=1))
        return flow

    def forward(self, ref, supp):
        h, w = ref.shape[2:4]
        w_up = w if (w % 32) == 0 else 32 * (w // 32 + 1)
        h_up = h if (h % 32) == 0 else 32 * (h // 32 + 1)
        ref = F.interpolate(ref, size=(h_up, w_up), mode='bilinear', align_corners=False)
        supp = F.interpolate(supp, size=(h_up, w_up), mode='bilinear', align_corners=False)

        flow = F.interpolate(
            self.compute_flow(ref, supp), size=(h, w),
            mode='bilinear', align_corners=False)
        flow[:, 0, :, :] *= float(w) / float(w_up)
        flow[:, 1, :, :] *= float(h) / float(h_up)
        return flow


# ---------------------------------------------------------------------------
# BasicVSR
# ---------------------------------------------------------------------------

class BasicVSRNet(nn.Module):
    """BasicVSR (CVPR 2021) — x4 upsampling with bi-directional propagation."""

    def __init__(self, mid_channels=64, num_blocks=30):
        super().__init__()
        self.mid_channels = mid_channels
        self.spynet = SPyNet()
        self.backward_resblocks = ResidualBlocksWithInputConv(
            mid_channels + 3, mid_channels, num_blocks)
        self.forward_resblocks = ResidualBlocksWithInputConv(
            mid_channels + 3, mid_channels, num_blocks)

        self.fusion = nn.Conv2d(mid_channels * 2, mid_channels, 1, 1, 0, bias=True)
        self.upsample1 = PixelShufflePack(mid_channels, mid_channels, 2, upsample_kernel=3)
        self.upsample2 = PixelShufflePack(mid_channels, 64, 2, upsample_kernel=3)
        self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
        self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)
        self.img_upsample = nn.Upsample(scale_factor=4, mode='bilinear', align_corners=False)
        self.lrelu = nn.LeakyReLU(negative_slope=0.1, inplace=True)
        self.is_mirror_extended = False

    def check_if_mirror_extended(self, lrs):
        self.is_mirror_extended = False
        if lrs.size(1) % 2 == 0:
            lrs_1, lrs_2 = torch.chunk(lrs, 2, dim=1)
            if torch.norm(lrs_1 - lrs_2.flip(1)) == 0:
                self.is_mirror_extended = True

    def compute_flow(self, lrs):
        n, t, c, h, w = lrs.size()
        lrs_1 = lrs[:, :-1].reshape(-1, c, h, w)
        lrs_2 = lrs[:, 1:].reshape(-1, c, h, w)
        flows_backward = self.spynet(lrs_1, lrs_2).view(n, t - 1, 2, h, w)
        if self.is_mirror_extended:
            flows_forward = None
        else:
            flows_forward = self.spynet(lrs_2, lrs_1).view(n, t - 1, 2, h, w)
        return flows_forward, flows_backward

    def forward(self, lrs):
        n, t, c, h, w = lrs.size()
        self.check_if_mirror_extended(lrs)
        flows_forward, flows_backward = self.compute_flow(lrs)

        # backward-time propagation
        outputs = []
        feat_prop = lrs.new_zeros(n, self.mid_channels, h, w)
        for i in range(t - 1, -1, -1):
            if i < t - 1:
                flow = flows_backward[:, i]
                feat_prop = flow_warp(feat_prop, flow.permute(0, 2, 3, 1))
            feat_prop = torch.cat([lrs[:, i], feat_prop], dim=1)
            feat_prop = self.backward_resblocks(feat_prop)
            outputs.append(feat_prop)
        outputs = outputs[::-1]

        # forward-time propagation + upsampling
        feat_prop = torch.zeros_like(feat_prop)
        for i in range(0, t):
            lr_curr = lrs[:, i]
            if i > 0:
                flow = flows_forward[:, i - 1] if flows_forward is not None \
                    else flows_backward[:, -i]
                feat_prop = flow_warp(feat_prop, flow.permute(0, 2, 3, 1))
            feat_prop = torch.cat([lr_curr, feat_prop], dim=1)
            feat_prop = self.forward_resblocks(feat_prop)

            out = torch.cat([outputs[i], feat_prop], dim=1)
            out = self.lrelu(self.fusion(out))
            out = self.lrelu(self.upsample1(out))
            out = self.lrelu(self.upsample2(out))
            out = self.lrelu(self.conv_hr(out))
            out = self.conv_last(out)
            out = out + self.img_upsample(lr_curr)
            outputs[i] = out

        return torch.stack(outputs, dim=1)


# ---------------------------------------------------------------------------
# RealBasicVSR = image cleaning + BasicVSR
# ---------------------------------------------------------------------------

class RealBasicVSRNet(nn.Module):

    def __init__(self,
                 mid_channels=64,
                 num_propagation_blocks=20,
                 num_cleaning_blocks=20,
                 dynamic_refine_thres=255,
                 is_sequential_cleaning=True):
        super().__init__()
        self.dynamic_refine_thres = dynamic_refine_thres / 255.0
        self.is_sequential_cleaning = is_sequential_cleaning

        self.image_cleaning = nn.Sequential(
            ResidualBlocksWithInputConv(3, mid_channels, num_cleaning_blocks),
            nn.Conv2d(mid_channels, 3, 3, 1, 1, bias=True),
        )
        self.basicvsr = BasicVSRNet(mid_channels, num_propagation_blocks)
        self.basicvsr.spynet.requires_grad_(False)

    def forward(self, lqs, return_lqs=False):
        n, t, c, h, w = lqs.size()
        for _ in range(3):  # at most 3 cleaning iterations
            if self.is_sequential_cleaning:
                residues = []
                for i in range(t):
                    residue_i = self.image_cleaning(lqs[:, i])
                    lqs[:, i] += residue_i
                    residues.append(residue_i)
                residues = torch.stack(residues, dim=1)
            else:
                lqs_flat = lqs.reshape(-1, c, h, w)
                residues = self.image_cleaning(lqs_flat)
                lqs = (lqs_flat + residues).view(n, t, c, h, w)
            if torch.mean(torch.abs(residues)) < self.dynamic_refine_thres:
                break

        outputs = self.basicvsr(lqs)
        if return_lqs:
            return outputs, lqs
        return outputs


# ---------------------------------------------------------------------------
# checkpoint loading
# ---------------------------------------------------------------------------

def _strip_prefixes(state_dict, prefixes=('generator.', 'module.')):
    out = {}
    for k, v in state_dict.items():
        for p in prefixes:
            if k.startswith(p):
                k = k[len(p):]
                break
        out[k] = v
    return out


def load_realbasicvsr(ckpt_path, spynet_path=None, device='cuda', fp16=True,
                      is_sequential_cleaning=True):
    """Build RealBasicVSRNet and load official weights.

    Handles both standalone-repo checkpoints (bare state_dict) and
    mmedit checkpoints ({'state_dict': {'generator.xxx': ...}}).
    """
    model = RealBasicVSRNet(is_sequential_cleaning=is_sequential_cleaning)

    raw = torch.load(ckpt_path, map_location='cpu', weights_only=True)
    sd = raw.get('state_dict', raw) if isinstance(raw, dict) else raw
    sd = _strip_prefixes(sd)

    # SPyNet: prefer the dedicated official SPyNet checkpoint (exact keys);
    # fall back to whatever is embedded in the main checkpoint.
    if spynet_path:
        sp_raw = torch.load(spynet_path, map_location='cpu', weights_only=True)
        sp_sd = _strip_prefixes(sp_raw.get('state_dict', sp_raw)
                                if isinstance(sp_raw, dict) else sp_raw)
        sp_missing, _ = model.basicvsr.spynet.load_state_dict(sp_sd, strict=False)
        # mean/std 是常数 buffer，官方权重不含它们，属正常
        sp_missing = [k for k in sp_missing if k not in ('mean', 'std')]
        if sp_missing:
            raise RuntimeError(f'SPyNet 权重缺失键: {sp_missing[:10]}')
    else:
        # 无独立 SPyNet 权重时，靠主 checkpoint 内嵌键填充（官方 ckpt 含全部 124 键）。
        # 若主权重也不含，spynet 将保持随机初始化——不报错但输出是坏的，必须明确告警
        embedded = sum(1 for k in sd if 'spynet' in k)
        if embedded:
            print(f'[realbasicvsr] 未提供独立 SPyNet 权重，使用主权重内嵌键（{embedded} 个）')
        else:
            print('[realbasicvsr] 警告：未提供 spynet.pth 且主权重未内嵌 SPyNet 键，'
                  '光流网络为随机初始化，输出质量将严重下降')

    missing, unexpected = model.load_state_dict(sd, strict=False)
    # keys handled separately / training-only
    missing = [k for k in missing if 'spynet' not in k]
    if missing:
        raise RuntimeError(f'权重缺失键: {missing[:10]}')
    if unexpected:
        # discriminator / optimizer leftovers are fine to ignore
        unexpected = [k for k in unexpected
                      if not k.startswith(('discriminator', 'optim', 'step'))]
        if unexpected:
            print(f'[realbasicvsr] 忽略多余权重键: {len(unexpected)} 个')

    model.eval().to(device)
    if fp16 and device.startswith('cuda'):
        model.half()
        # SPyNet keeps fp32 for numerical stability of flow estimation
        model.basicvsr.spynet.float()
    return model
