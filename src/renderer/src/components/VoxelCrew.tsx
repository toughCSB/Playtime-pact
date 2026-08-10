interface VoxelCrewProps {
  variant?: 'home' | 'settings' | 'admin' | 'compact'
}

export default function VoxelCrew({ variant = 'home' }: VoxelCrewProps) {
  return (
    <div className={`ppt-voxel-scene ppt-voxel-scene--${variant}`} aria-hidden="true">
      <span className="ppt-voxel-scene__sun" />
      <span className="ppt-voxel-scene__cloud ppt-voxel-scene__cloud--one" />
      <span className="ppt-voxel-scene__cloud ppt-voxel-scene__cloud--two" />
      <span className="ppt-voxel-scene__hill ppt-voxel-scene__hill--back" />
      <span className="ppt-voxel-scene__hill ppt-voxel-scene__hill--front" />
      <span className="ppt-voxel-block ppt-voxel-block--grass" />
      <span className="ppt-voxel-block ppt-voxel-block--stone" />

      <span className="ppt-voxel-character ppt-voxel-character--explorer">
        <span className="ppt-voxel-character__head">
          <span className="ppt-voxel-character__hair" />
          <span className="ppt-voxel-character__eye ppt-voxel-character__eye--left" />
          <span className="ppt-voxel-character__eye ppt-voxel-character__eye--right" />
          <span className="ppt-voxel-character__smile" />
        </span>
        <span className="ppt-voxel-character__body" />
        <span className="ppt-voxel-character__arm ppt-voxel-character__arm--left" />
        <span className="ppt-voxel-character__arm ppt-voxel-character__arm--right" />
        <span className="ppt-voxel-character__leg ppt-voxel-character__leg--left" />
        <span className="ppt-voxel-character__leg ppt-voxel-character__leg--right" />
      </span>

      <span className="ppt-voxel-character ppt-voxel-character--builder">
        <span className="ppt-voxel-character__head">
          <span className="ppt-voxel-character__cap" />
          <span className="ppt-voxel-character__eye ppt-voxel-character__eye--left" />
          <span className="ppt-voxel-character__eye ppt-voxel-character__eye--right" />
          <span className="ppt-voxel-character__smile" />
        </span>
        <span className="ppt-voxel-character__body" />
        <span className="ppt-voxel-character__arm ppt-voxel-character__arm--left" />
        <span className="ppt-voxel-character__arm ppt-voxel-character__arm--right" />
        <span className="ppt-voxel-character__leg ppt-voxel-character__leg--left" />
        <span className="ppt-voxel-character__leg ppt-voxel-character__leg--right" />
      </span>
    </div>
  )
}
