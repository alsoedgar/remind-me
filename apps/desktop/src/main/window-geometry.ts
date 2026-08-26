export interface WindowRectangle {
  x: number
  y: number
  width: number
  height: number
}

export function widgetBoundsForWorkArea(workArea: WindowRectangle): WindowRectangle {
  const margin = 24
  const width = Math.min(420, Math.max(340, workArea.width - margin * 2))
  const height = Math.min(680, Math.max(480, workArea.height - margin * 2))
  return {
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,
    width,
    height
  }
}

export function glanceBoundsForWorkArea(workArea: WindowRectangle): WindowRectangle {
  const margin = 18
  const width = Math.min(304, Math.max(272, workArea.width - margin * 2))
  const height = Math.min(268, Math.max(228, workArea.height - margin * 2))
  return {
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,
    width,
    height
  }
}

export function fitWindowBounds(
  bounds: WindowRectangle,
  workArea: WindowRectangle,
  minimumWidth: number,
  minimumHeight: number
): WindowRectangle {
  const width = Math.min(workArea.width, Math.max(minimumWidth, bounds.width))
  const height = Math.min(workArea.height, Math.max(minimumHeight, bounds.height))
  const maximumX = workArea.x + workArea.width - width
  const maximumY = workArea.y + workArea.height - height
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), maximumX),
    y: Math.min(Math.max(bounds.y, workArea.y), maximumY),
    width,
    height
  }
}
