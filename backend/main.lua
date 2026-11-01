local logger     = require("logger")
local millennium = require("millennium")

-- registers am_status / am_apply, the functions the frontend calls
require("rpc_functions")

local function on_load()
    logger:info("Achievement Manager loaded")
    millennium.ready()
end

local function on_unload()
    logger:info("Achievement Manager unloaded")
end

local function on_frontend_loaded()
    logger:info("Achievement Manager frontend loaded")
end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
