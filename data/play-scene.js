class PlayScene extends Scene {
    constructor() {
        super();
        this.player;
        this.pipes = [];
    }

    start() {
        super.start();
        
        let pipeCount = width / (PIPE_BETWEEN + PIPE_WIDTH);
        
        for (let i = 1; i <= pipeCount + 2; i++) {
            new Pipe(width - PIPE_WIDTH + i * (PIPE_BETWEEN + PIPE_WIDTH), random(PIPE_NO_GAP_ZONE, height-PIPE_NO_GAP_ZONE));
        }
    
        this.player = new Bird(BIRD_X, 100, null, true); 
    }

    update() {
        super.update();

        this.player.update();

        this.pipes.forEach(pipe => {
            this.pipe.update();
            }
        );
    }

    draw() {      
        background(color(BG_COLOR));
        
        this.pipes.forEach(pipe => {
            this.pipe.show();
        });

        this.player.show();

        push();
            noStroke();
            fill(color(GROUND_COLOR));
            rect(0, height - GROUND_HEIGHT, width, GROUND_HEIGHT);
        pop();

        push();
            textAlign(CENTER);
            fill(255);
            textSize(60);
            text(this.player.point, width/2,60);
        pop();
    }

    mouseReleased() {
        if (this.player.live){
            this.player.jump();
        }else{
            start();
        }
    }
}