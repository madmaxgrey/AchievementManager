local logger     = require("logger")
local millennium = require("millennium")

-- defines the RPC functions (am_status / am_apply) the frontend calls through `backend`
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
